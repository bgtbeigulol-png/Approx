import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Spring, clamp } from './anim.js';
import { contentDiff, parseUnifiedDiff } from './file-changes.js';

const GIT_SPRING = { stiff: 20, damp: 0.86 };
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

export function createGitState() {
  return {
    open: false,
    anim: new Spring(0, GIT_SPRING),
    gate: new Spring(0, { stiff: 24, damp: 0.72 }),
    // Fires on every successful index transfer so the gate can flash without
    // the persistent motion the `t` clock alone would give it.
    pulse: new Spring(0, { stiff: 18, damp: 0.7 }),
    root: '',
    branch: { name: '-', upstream: '', ahead: 0, behind: 0, detached: false, initial: false },
    lanes: [[], []],
    lane: 0,
    selected: [0, 0],
    laneScroll: [0, 0],
    commits: [],
    // Change overview: net added/removed lines from HEAD to the worktree.
    // Untracked files never reach numstat, so refreshGit folds their lines in
    // after the first paint.
    totals: { added: 0, removed: 0 },
    diff: [],
    diffPath: '',
    diffSide: '',
    diffScroll: 0,
    diffBinary: false,
    // True while a diff read for the selected file is in flight. The pane shows
    // a placeholder instead of the previous file's diff during that window.
    diffLoading: false,
    // How many diff rows the pane last showed. The view knows this; the key
    // handler needs it so page/wheel scrolling stops exactly at the last screen.
    diffRows: 1,
    loading: false,
    error: '',
    hits: [],
    // The control under the pointer, latched on mousemove so the view can light
    // it up. Cleared when the pointer leaves every target.
    hover: null,
    // Lane list rectangles, recorded by the view so a wheel event over a list can
    // move that list instead of always scrolling the diff pane.
    laneBox: [null, null],
    // Latched transfer direction. The gate spring returns to rest within a few
    // frames, so reading its sign told us nothing about which way the last file
    // actually moved.
    gateDir: 1,
    seq: 0,
    diffSeq: 0,
  };
}

/** Parse `git status --porcelain=v1 -z --branch`. */
export function parseGitStatus(output) {
  const records = String(output ?? '').split('\0');
  const branch = parseBranch(records.shift() ?? '');
  const worktree = [];
  const staged = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.length < 3) continue;
    const x = record[0];
    const y = record[1];
    const path = record.slice(3);
    let originalPath = '';
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') originalPath = records[++i] ?? '';
    const entry = { x, y, path, originalPath, code: `${x}${y}` };
    if (x !== ' ' && x !== '?') staged.push({ ...entry, side: 'staged', mark: x });
    if (y !== ' ' || x === '?') worktree.push({ ...entry, side: 'worktree', mark: x === '?' ? '?' : y });
  }
  return { branch, worktree, staged };
}

export const gitMethods = {
  openGit() {
    if (!this.st.git?.anim) this.st.git = createGitState();
    this.closeSettings?.();
    this.st.view = 'git';
    this.st.git.open = true;
    this.st.git.anim.set(1, this.st.reduceMotion);
    this.s.invalidate();
    void this.refreshGit();
  },

  closeGit() {
    const state = this.st.git;
    if (!state) return;
    state.open = false;
    state.anim.set(0, this.st.reduceMotion);
    this.st.view = 'chat';
    this.s.invalidate();
  },

  async refreshGit() {
    const state = this.st.git;
    const seq = ++state.seq;
    const keep = [
      state.lanes[0]?.[state.selected[0]]?.path ?? '',
      state.lanes[1]?.[state.selected[1]]?.path ?? '',
    ];
    state.loading = true;
    state.error = '';
    // Drop the previous pane before the status read, so reopening /git or a
    // refresh never shows a diff for a selection that may no longer exist.
    state.diff = [];
    state.diffPath = '';
    state.diffSide = '';
    state.diffLoading = true;
    this.s.invalidate();
    try {
      const inside = (await runGit(['rev-parse', '--is-inside-work-tree'], this.st.cwdPath)).stdout.trim();
      if (inside !== 'true') throw new Error('not a Git repository');
      const root = (await runGit(['rev-parse', '--show-toplevel'], this.st.cwdPath)).stdout.trim();
      const [statusResult, logResult, worktreeNumstat] = await Promise.all([
        runGit(['-c', 'status.relativePaths=false', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], root),
        runGit(['log', '-5', '--pretty=format:%h%x00%s%x00%cr%x00'], root, { allow: [0, 128] }),
        readWorktreeNumstat(root),
      ]);
      if (seq !== state.seq) return;
      const parsed = parseGitStatus(statusResult.stdout);
      state.root = root;
      state.branch = parsed.branch;
      // A single base-to-worktree diff reports net changes. Adding the staged
      // and unstaged lane stats would double-count intermediate edits on MM/AM
      // files because numstat is not additive across diffs.
      state.totals = parseNumstatTotals(worktreeNumstat.stdout);
      state.lanes = [parsed.worktree, parsed.staged];
      state.commits = parseCommitLog(logResult.stdout);
      // Keep the cursor on the same path across a refresh where possible. Staging
      // a file renumbers both lanes, and holding a bare index made the selection
      // jump to whatever slid into that slot.
      for (let lane = 0; lane < 2; lane++) {
        const want = keep[lane];
        const moved = want ? state.lanes[lane].findIndex((f) => f.path === want) : -1;
        state.selected[lane] = clamp(moved >= 0 ? moved : state.selected[lane],
          0, Math.max(0, state.lanes[lane].length - 1));
        state.laneScroll[lane] = clamp(state.laneScroll[lane], 0, Math.max(0, state.lanes[lane].length - 1));
      }
      // Staging the last worktree file used to leave the cursor parked on an empty
      // lane with a blank diff pane, as if the change had been lost.
      if (!state.lanes[state.lane].length && state.lanes[1 - state.lane].length) {
        state.lane = 1 - state.lane;
      }
      state.loading = false;
      void this.addUntrackedTotals(seq, parsed.worktree);
      await this.refreshGitDiff(seq);
    } catch (error) {
      if (seq !== state.seq) return;
      state.loading = false;
      state.error = cleanGitError(error);
      state.lanes = [[], []];
      state.totals = { added: 0, removed: 0 };
      state.diff = [];
      state.diffPath = '';
      state.diffSide = '';
      state.diffLoading = false;
      this.s.invalidate();
      this.requestFrame();
    }
  },

  async refreshGitDiff(parentSeq = this.st.git.seq) {
    const state = this.st.git;
    const entry = state.lanes[state.lane]?.[state.selected[state.lane]];
    // Two clocks guard this pane. `seq` is the refresh generation; `diffSeq` is the
    // selection generation. Without the second one, a slow read for the file the
    // cursor just left could still land and repaint over the newer selection.
    const mine = ++state.diffSeq;
    const current = () => parentSeq === state.seq && mine === state.diffSeq;
    state.diffScroll = 0;
    state.diffBinary = false;
    if (!entry || !state.root) {
      // A deselected lane must never linger on the last file's diff.
      state.diff = [];
      state.diffPath = '';
      state.diffSide = '';
      state.diffLoading = false;
      this.s.invalidate();
      this.requestFrame();
      return;
    }
    // Repaint immediately with the new path and an empty pane. The read below is
    // async, and until it landed the old diff stayed on screen, so the pane kept
    // previewing the file under the previous selection while the cursor already
    // sat on the new one. The same file on the same side stays on screen while
    // it refreshes, so re-selecting a row or pressing R does not flash a blank.
    if (state.diffPath !== entry.path || state.diffSide !== entry.side) {
      state.diff = [];
      state.diffPath = entry.path;
      state.diffSide = entry.side;
      state.diffLoading = true;
      this.s.invalidate();
    }
    try {
      if (entry.side === 'worktree' && entry.x === '?') {
        // Read bytes, not text: an untracked binary decoded as UTF-8 used to pipe
        // NUL and replacement characters straight into the cell buffer.
        const path = join(state.root, entry.path);
        const info = await stat(path);
        if (!info.isFile()) throw new Error('selected change is not a regular file');
        if (info.size > MAX_DIFF_BYTES) {
          if (!current()) return;
          state.diffLoading = false;
          state.diff = [{
            kind: 'meta',
            text: `preview skipped · ${formatBytes(info.size)} exceeds the ${formatBytes(MAX_DIFF_BYTES)} limit`,
            oldLine: null,
            newLine: null,
          }];
          this.s.invalidate();
          this.requestFrame();
          return;
        }
        const raw = await readFile(path);
        if (!current()) return;
        state.diffLoading = false;
        if (isBinaryBuffer(raw)) {
          state.diffBinary = true;
          state.diff = [{ kind: 'meta', text: `binary file · ${formatBytes(raw.length)}`, oldLine: null, newLine: null }];
        } else {
          state.diff = contentDiff(entry.path, '', raw.toString('utf8'));
        }
      } else {
        const args = entry.side === 'staged'
          ? ['diff', '--cached', '--no-ext-diff', '--no-color', '--', entry.path]
          : ['diff', '--no-ext-diff', '--no-color', '--', entry.path];
        const result = await runGit(args, state.root, { maxOutputBytes: MAX_DIFF_BYTES });
        if (!current()) return;
        state.diffLoading = false;
        if (isBinaryBuffer(result.raw)) {
          state.diffBinary = true;
          state.diff = [{ kind: 'meta', text: 'binary file · no textual diff', oldLine: null, newLine: null }];
        } else {
          state.diff = parseUnifiedDiff(result.stdout);
          if (result.truncated) {
            state.diff.push({
              kind: 'meta',
              text: `... diff preview clipped at ${formatBytes(MAX_DIFF_BYTES)}`,
              oldLine: null,
              newLine: null,
            });
          }
        }
      }
      if (current()) {
        this.s.invalidate();
        // The read resolved outside any key handler. Without a requested frame
        // the new diff would sit unrendered until the next input event, leaving
        // the pane stuck on its placeholder (or the previous file, before the
        // pane cleared synchronously).
        this.requestFrame();
      }
    } catch (error) {
      if (current()) {
        state.diffLoading = false;
        state.diff = [{ kind: 'meta', text: cleanGitError(error), oldLine: null, newLine: null }];
        this.s.invalidate();
        this.requestFrame();
      }
    }
  },

  /**
   * Fold untracked files into the masthead change overview. `git diff --numstat`
   * never lists them, yet the worktree lane shows them as pure additions, so the
   * total would quietly undercount. Runs detached from the refresh so a large
   * untracked tree cannot stall the pane; the seq guard drops stale counts.
   */
  async addUntrackedTotals(seq, worktree) {
    const state = this.st.git;
    const untracked = (worktree ?? []).filter((file) => file.x === '?');
    if (!untracked.length) return;
    const added = await countUntrackedLines(state.root, untracked);
    if (seq !== state.seq || !state.totals) return;
    state.totals.added += added;
    this.s.invalidate();
    this.requestFrame();
  },

  gitSelectLane(lane) {
    const state = this.st.git;
    state.lane = clamp(lane, 0, 1);
    void this.refreshGitDiff();
  },

  gitMoveSelection(delta) {
    const state = this.st.git;
    const files = state.lanes[state.lane] ?? [];
    if (!files.length) return;
    state.selected[state.lane] = (state.selected[state.lane] + delta + files.length) % files.length;
    void this.refreshGitDiff();
  },

  async gitTransferSelected() {
    const state = this.st.git;
    const entry = state.lanes[state.lane]?.[state.selected[state.lane]];
    if (!entry || state.loading) return;
    // Latch the direction as well as kicking the spring. The spring is back at rest
    // within a few frames, so the arrow had nothing left to read from.
    state.gateDir = state.lane === 0 ? 1 : -1;
    state.gate.set(state.gateDir, true);
    state.gate.set(0);
    state.pulse?.set(1, true);
    state.pulse?.set(0);
    await this.gitOperation(state.lane === 0
      ? ['add', '--', entry.path]
      : state.branch.initial
        ? ['rm', '--cached', '--', entry.path]
        : ['restore', '--staged', '--', entry.path]);
  },

  async gitStageAll() { await this.gitOperation(['add', '-A']); },
  async gitUnstageAll() {
    await this.gitOperation(this.st.git.branch.initial
      ? ['rm', '-r', '--cached', '--', '.']
      : ['restore', '--staged', '--', '.']);
  },

  /**
   * Throw away the worktree changes for the selected file. This is destructive
   * and cannot be undone through git, so it always routes through a confirm
   * prompt first. Untracked files are deleted from disk; tracked files are
   * restored to their HEAD (or index) contents.
   */
  async gitDiscardSelected() {
    const state = this.st.git;
    if (state.loading) return;
    // Discard only makes sense against the worktree lane.
    const target = state.lane === 0 ? state.lanes[0]?.[state.selected[0]] : null;
    if (!target) return this.toast('select a worktree file to discard', 'warn');
    const untracked = target.x === '?';
    const result = await this.openQuestionnaire({
      id: `git-discard-${Date.now().toString(36)}`,
      title: 'DISCARD / CHANGES',
      intro: untracked
        ? `Delete untracked file ${target.path} from disk?`
        : `Throw away worktree changes to ${target.path}?`,
      questions: [{
        id: 'confirm', type: 'select', prompt: 'This cannot be undone', required: true,
        options: ['Keep the file', 'Discard changes'],
      }],
    });
    if (result.cancelled) return;
    const choice = String(result.values?.confirm ?? '');
    if (!/discard/i.test(choice)) return;
    await this.gitOperation(untracked
      ? ['clean', '-f', '--', target.path]
      : ['restore', '--worktree', '--', target.path], 'changes discarded');
  },

  async gitCommit() {
    const state = this.st.git;
    if (!state.lanes[1].length || state.loading) return this.toast('nothing staged to commit', 'warn');
    const result = await this.openQuestionnaire({
      id: `git-commit-${Date.now()}`,
      title: 'COMMIT / MESSAGE',
      intro: `${state.lanes[1].length} staged file${state.lanes[1].length === 1 ? '' : 's'}`,
      questions: [{
        id: 'message', type: 'text', prompt: 'Commit message', placeholder: 'Describe this change',
        required: true, maxLength: 4000,
      }],
    });
    if (result.cancelled) return;
    const message = String(result.values?.message ?? '').trim();
    if (!message) return;
    await this.gitOperation(['commit', '-m', message], 'commit created');
  },

  async gitOperation(args, success = '') {
    const state = this.st.git;
    state.loading = true;
    state.error = '';
    this.s.invalidate();
    try {
      await runGit(args, state.root || this.st.cwdPath);
      if (success) this.toast(success, 'ok');
      await this.refreshGit();
    } catch (error) {
      state.loading = false;
      state.error = cleanGitError(error);
      this.toast(state.error, 'warn');
      this.s.invalidate();
    }
  },

  gitKey(k) {
    // Some terminal decoders hand us a keypress with no name at all; reaching
    // straight for `.toLowerCase()` below took the whole page down with it.
    const name = typeof k?.name === 'string' ? k.name : '';
    const plain = !k.ctrl && !k.alt;
    if (name === 'escape' || (k.ctrl && name === 'k')) return this.closeGit();
    if (name === 'tab') return this.gitSelectLane(this.st.git.lane === 0 ? 1 : 0);
    if (name === 'left') return this.gitSelectLane(0);
    if (name === 'right') return this.gitSelectLane(1);
    if (name === 'up') return this.gitMoveSelection(-1);
    if (name === 'down') return this.gitMoveSelection(1);
    if (name === 'home') return this.gitJumpSelection(-1);
    if (name === 'end') return this.gitJumpSelection(1);
    if (name === 'pageup') return void this.gitScrollDiff(-8);
    if (name === 'pagedown') return void this.gitScrollDiff(8);
    // A wheel event over a file list should move that list. Sending every wheel
    // tick to the diff pane made the lists feel dead under the mouse.
    if (name === 'wheelup' || name === 'wheeldown') {
      const step = name === 'wheelup' ? -1 : 1;
      const lane = this.gitLaneAt(k.x, k.y);
      if (lane >= 0) {
        if (lane !== this.st.git.lane) this.st.git.lane = lane;
        return this.gitMoveSelection(step * 2);
      }
      return void this.gitScrollDiff(step * 3);
    }
    if (name === 'space' || name === 'return' || name === 'enter') return void this.gitTransferSelected();
    if (plain && name.toLowerCase() === 'a') return void this.gitStageAll();
    if (plain && name.toLowerCase() === 'u') return void this.gitUnstageAll();
    if (plain && name.toLowerCase() === 'c') return void this.gitCommit();
    if (plain && name.toLowerCase() === 'd') return void this.gitDiscardSelected();
    if (plain && name.toLowerCase() === 'r') return void this.refreshGit();
    if (name === 'mousemove') return this.gitPointer(k.x, k.y, false);
    if (name === 'mousedown') return this.gitPointer(k.x, k.y, true);
  },

  /** Which lane list, if any, sits under a pointer position. */
  gitLaneAt(x, y) {
    const boxes = this.st.git.laneBox ?? [];
    for (let lane = 0; lane < boxes.length; lane++) {
      const b = boxes[lane];
      if (b && y >= b.y1 && y <= b.y2 && x >= b.x1 && x <= b.x2) return lane;
    }
    return -1;
  },

  /** Clamp diff scrolling to the parsed diff so it cannot run off into blank space. */
  gitScrollDiff(delta) {
    const state = this.st.git;
    // Stop at the last full screen, not the last line: clamping to length-1 let
    // the pane scroll a whole page of blank rows past the final diff line.
    const max = Math.max(0, state.diff.length - Math.max(1, state.diffRows));
    state.diffScroll = clamp(state.diffScroll + delta, 0, max);
    this.s.invalidate();
  },

  gitJumpSelection(dir) {
    const state = this.st.git;
    const list = state.lanes[state.lane] ?? [];
    if (!list.length) return;
    state.selected[state.lane] = dir < 0 ? 0 : list.length - 1;
    state.diffScroll = 0;
    void this.refreshGitDiff();
  },

  gitPointer(x, y, activate = true) {
    const state = this.st.git;
    const hit = [...(state.hits ?? [])].reverse().find((item) =>
      y === item.y && x >= item.x1 && x <= item.x2);
    if (!activate) {
      // Track the control under the cursor so the view can light it up. Only
      // repaint when the hovered target actually changes, so idle mouse motion
      // over one button does not churn frames.
      const key = hit ? `${hit.kind}:${hit.lane ?? ''}:${hit.index ?? ''}` : '';
      if (key !== (state.hoverKey ?? '')) {
        state.hoverKey = key;
        state.hover = hit ? { kind: hit.kind, lane: hit.lane, index: hit.index } : null;
        this.s.invalidate();
      }
      return true;
    }
    if (!hit) return true;
    if (hit.kind === 'close') this.closeGit();
    else if (hit.kind === 'refresh') void this.refreshGit();
    else if (hit.kind === 'file') {
      state.lane = hit.lane;
      state.selected[hit.lane] = hit.index;
      void this.refreshGitDiff();
    } else if (hit.kind === 'gate') void this.gitTransferSelected();
    else if (hit.kind === 'stageAll') void this.gitStageAll();
    else if (hit.kind === 'unstageAll') void this.gitUnstageAll();
    else if (hit.kind === 'discard') void this.gitDiscardSelected();
    else if (hit.kind === 'commit') void this.gitCommit();
    return true;
  },

  stepGitAnimations(dt) {
    this.st.git.anim.step(dt);
    this.st.git.gate.step(dt);
    this.st.git.pulse?.step(dt);
  },
};

function parseBranch(record) {
  const text = String(record).replace(/^##\s*/, '');
  const branch = { name: '-', upstream: '', ahead: 0, behind: 0, detached: false, initial: false };
  if (/^No commits yet on /.test(text)) {
    branch.initial = true;
    branch.name = text.replace(/^No commits yet on /, '') || '-';
    return branch;
  }
  if (/^Initial commit on /.test(text)) {
    branch.initial = true;
    branch.name = text.replace(/^Initial commit on /, '') || '-';
    return branch;
  }
  if (/^HEAD \(no branch\)/.test(text)) {
    branch.detached = true;
    branch.name = 'DETACHED';
    return branch;
  }
  const match = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(text);
  branch.name = match?.[1] || text || '-';
  branch.upstream = match?.[2] || '';
  for (const part of (match?.[3] || '').split(', ')) {
    const ahead = /^ahead (\d+)$/.exec(part);
    const behind = /^behind (\d+)$/.exec(part);
    if (ahead) branch.ahead = Number(ahead[1]);
    if (behind) branch.behind = Number(behind[1]);
  }
  return branch;
}

function parseCommitLog(output) {
  const parts = String(output ?? '').split('\0').filter((part) => part !== '');
  const commits = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    commits.push({ hash: parts[i].trim(), subject: parts[i + 1].trim(), age: parts[i + 2].trim() });
  }
  return commits;
}

/** Read the net tracked-file diff, including both index and worktree changes. */
async function readWorktreeNumstat(root) {
  const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root, { allow: [0, 1] });
  let base = 'HEAD';
  if (head.code !== 0) {
    // Compute instead of hard-coding the SHA-1 empty-tree id so this also works
    // in repositories initialized with SHA-256 object ids.
    base = (await runGit(['hash-object', '-t', 'tree', '--stdin'], root, { input: '' })).stdout.trim();
  }
  return runGit(['diff', '--numstat', '--no-ext-diff', base], root);
}

/**
 * Parse `git diff --numstat` output into a change-overview tally. Binary files
 * report `-` for both counts and simply contribute nothing.
 */
function parseNumstatTotals(output) {
  const totals = { added: 0, removed: 0 };
  for (const line of String(output ?? '').split('\n')) {
    const fields = line.split('\t');
    if (fields.length < 3) continue;
    const added = Number(fields[0]);
    const removed = Number(fields[1]);
    if (Number.isFinite(added) && added > 0) totals.added += added;
    if (Number.isFinite(removed) && removed > 0) totals.removed += removed;
  }
  return totals;
}

/**
 * Count lines in untracked files so the overview matches the diff pane, which
 * renders them as pure additions. Binary and oversized files are skipped: a
 * stray build artifact must neither stall the refresh nor inflate the total.
 */
async function countUntrackedLines(root, entries) {
  const CONCURRENCY = 24;
  let lines = 0;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const counts = await Promise.all(entries.slice(i, i + CONCURRENCY).map(async (entry) => {
      try {
        const path = join(root, entry.path);
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_DIFF_BYTES) return 0;
        const raw = await readFile(path);
        if (isBinaryBuffer(raw)) return 0;
        const text = raw.toString('utf8');
        if (!text) return 0;
        return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      } catch {
        return 0;
      }
    }));
    for (const count of counts) lines += count;
  }
  return lines;
}

function runGit(args, cwd, { allow = [0], input = null, maxOutputBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, shell: false });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let truncated = false;
    child.stdout.on('data', (chunk) => {
      if (stdoutBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length > remaining) {
        stdout.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
      } else {
        stdout.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.stdin.end(input ?? undefined);
    child.on('close', (code) => {
      const raw = Buffer.concat(stdout);
      const result = {
        code,
        // Keep the bytes: the diff pane sniffs `raw` for NUL before it trusts
        // the text, so a binary blob never reaches the cell buffer as mojibake.
        raw,
        truncated,
        stdout: raw.toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (allow.includes(code)) resolve(result);
      else reject(new Error(result.stderr.trim() || `git exited with ${code}`));
    });
  });
}

function cleanGitError(error) {
  return String(error?.message ?? error).replace(/^fatal:\s*/i, '').trim() || 'git operation failed';
}

/**
 * Sniff a buffer for binary content the way git does: a NUL byte in the first
 * few kilobytes means "do not treat this as text". Cheap and good enough to keep
 * raw bytes out of the diff pane.
 */
function isBinaryBuffer(buffer) {
  if (!buffer || typeof buffer.length !== 'number') return false;
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
