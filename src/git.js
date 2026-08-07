import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Spring, clamp } from './anim.js';
import { contentDiff, parseUnifiedDiff } from './file-changes.js';

const GIT_SPRING = { stiff: 20, damp: 0.86 };

export function createGitState() {
  return {
    open: false,
    anim: new Spring(0, GIT_SPRING),
    gate: new Spring(0, { stiff: 24, damp: 0.72 }),
    root: '',
    branch: { name: '-', upstream: '', ahead: 0, behind: 0, detached: false, initial: false },
    lanes: [[], []],
    lane: 0,
    selected: [0, 0],
    laneScroll: [0, 0],
    commits: [],
    diff: [],
    diffPath: '',
    diffScroll: 0,
    loading: false,
    error: '',
    hits: [],
    seq: 0,
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
    state.loading = true;
    state.error = '';
    this.s.invalidate();
    try {
      const root = (await runGit(['rev-parse', '--show-toplevel'], this.st.cwdPath)).stdout.trim();
      const [statusResult, logResult] = await Promise.all([
        runGit(['-c', 'status.relativePaths=false', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], root),
        runGit(['log', '-5', '--pretty=format:%h%x00%s%x00%cr%x00'], root, { allow: [0, 128] }),
      ]);
      if (seq !== state.seq) return;
      const parsed = parseGitStatus(statusResult.stdout);
      state.root = root;
      state.branch = parsed.branch;
      state.lanes = [parsed.worktree, parsed.staged];
      state.commits = parseCommitLog(logResult.stdout);
      for (let lane = 0; lane < 2; lane++) {
        state.selected[lane] = clamp(state.selected[lane], 0, Math.max(0, state.lanes[lane].length - 1));
        state.laneScroll[lane] = clamp(state.laneScroll[lane], 0, Math.max(0, state.lanes[lane].length - 1));
      }
      state.loading = false;
      await this.refreshGitDiff(seq);
    } catch (error) {
      if (seq !== state.seq) return;
      state.loading = false;
      state.error = cleanGitError(error);
      state.lanes = [[], []];
      state.diff = [];
      state.diffPath = '';
      this.s.invalidate();
    }
  },

  async refreshGitDiff(parentSeq = this.st.git.seq) {
    const state = this.st.git;
    const entry = state.lanes[state.lane]?.[state.selected[state.lane]];
    state.diffScroll = 0;
    if (!entry || !state.root) {
      state.diff = [];
      state.diffPath = '';
      this.s.invalidate();
      return;
    }
    state.diffPath = entry.path;
    try {
      if (entry.side === 'worktree' && entry.x === '?') {
        const text = await readFile(join(state.root, entry.path), 'utf8');
        state.diff = contentDiff(entry.path, '', text);
      } else {
        const args = entry.side === 'staged'
          ? ['diff', '--cached', '--no-ext-diff', '--no-color', '--', entry.path]
          : ['diff', '--no-ext-diff', '--no-color', '--', entry.path];
        state.diff = parseUnifiedDiff((await runGit(args, state.root)).stdout);
      }
      if (parentSeq === state.seq) this.s.invalidate();
    } catch (error) {
      if (parentSeq === state.seq) {
        state.diff = [{ kind: 'meta', text: cleanGitError(error), oldLine: null, newLine: null }];
        this.s.invalidate();
      }
    }
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
    state.gate.set(state.lane === 0 ? 1 : -1, true);
    state.gate.set(0);
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
    if (k.name === 'escape' || (k.ctrl && k.name === 'k')) return this.closeGit();
    if (k.name === 'tab') return this.gitSelectLane(this.st.git.lane === 0 ? 1 : 0);
    if (k.name === 'left') return this.gitSelectLane(0);
    if (k.name === 'right') return this.gitSelectLane(1);
    if (k.name === 'up') return this.gitMoveSelection(-1);
    if (k.name === 'down') return this.gitMoveSelection(1);
    if (k.name === 'pageup') return void (this.st.git.diffScroll = Math.max(0, this.st.git.diffScroll - 8));
    if (k.name === 'pagedown') return void (this.st.git.diffScroll += 8);
    if (k.name === 'wheelup') return void (this.st.git.diffScroll = Math.max(0, this.st.git.diffScroll - 3));
    if (k.name === 'wheeldown') return void (this.st.git.diffScroll += 3);
    if (k.name === 'space') return void this.gitTransferSelected();
    if (!k.ctrl && !k.alt && k.name.toLowerCase() === 'a') return void this.gitStageAll();
    if (!k.ctrl && !k.alt && k.name.toLowerCase() === 'u') return void this.gitUnstageAll();
    if (!k.ctrl && !k.alt && k.name.toLowerCase() === 'c') return void this.gitCommit();
    if (!k.ctrl && !k.alt && k.name.toLowerCase() === 'r') return void this.refreshGit();
    if (k.name === 'mousemove') return this.gitPointer(k.x, k.y, false);
    if (k.name === 'mousedown') return this.gitPointer(k.x, k.y, true);
  },

  gitPointer(x, y, activate = true) {
    const hit = [...(this.st.git.hits ?? [])].reverse().find((item) =>
      y === item.y && x >= item.x1 && x <= item.x2);
    if (!hit || !activate) return true;
    if (hit.kind === 'close') this.closeGit();
    else if (hit.kind === 'refresh') void this.refreshGit();
    else if (hit.kind === 'file') {
      this.st.git.lane = hit.lane;
      this.st.git.selected[hit.lane] = hit.index;
      void this.refreshGitDiff();
    } else if (hit.kind === 'gate') void this.gitTransferSelected();
    else if (hit.kind === 'stageAll') void this.gitStageAll();
    else if (hit.kind === 'unstageAll') void this.gitUnstageAll();
    else if (hit.kind === 'commit') void this.gitCommit();
    return true;
  },

  stepGitAnimations(dt) {
    this.st.git.anim.step(dt);
    this.st.git.gate.step(dt);
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

function runGit(args, cwd, { allow = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, shell: false });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
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
