import * as smoke from './shared.js';

const {
  Screen, enterTui, attach, decode, wrapText, ellipsize, padTo,
  strWidth, rgb, mix, moveTo, HIDE_CURSOR, SHOW_CURSOR, CURSOR_STEADY_BAR,
  SAVE_CURSOR, RESTORE_CURSOR, SYNC_START, SYNC_END, clipboardSequence,
  Spring, Tween, ease, clamp, drawSplash, SPLASH_MS,
  drawPalette, fuzzy, filterCommands, paletteLayout,
  drawTranscript, layout, totalHeight, visibleLines, drawGit,
  buildFileChanges, parseGitStatus, railTicks, tickAtRow, tickLabel, RAIL_W,
  settingsModel, settingsRows, applySetting,
  drawJumpList, jumpResults, jumpLabel, jumpLayout, logicalTimeline,
  drawComposer, drawCompact, drawPlanPanel,
  layoutComposerInput, setComposerInput, insertComposerText, moveComposerCursor,
  applyPlanOperation, buildPlanTurnInjection, createPlanState, serializePlanState,
  createApproxHostTools, createApprodeState, approdeRows, navigableRows,
  loadPreferences, savePreferences, Harness, App, createAppState, PiBackend,
  toolMessages, T, paper, drawPaperGrain,
  EventEmitter, spawnSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
  tmpdir, join, SAMPLE_LONG, ok, recordError, FakeOut,
} = smoke;
// ---- per-turn FILE CHANGES summary and shared diff model ----
{
  const snapshot = (text, exists = true) => ({
    exists,
    data: exists ? Buffer.from(text).toString('base64') : '',
  });
  const editedPath = join(process.cwd(), 'src', 'fixture-edit.js');
  const newPath = join(process.cwd(), 'src', 'fixture-new.js');
  const deletedPath = join(process.cwd(), 'src', 'fixture-old.js');
  const mutations = [
    { path: editedPath, before: snapshot('alpha\n'), after: snapshot('beta\n') },
    { path: editedPath, before: snapshot('beta\n'), after: snapshot('gamma\n') },
    { path: newPath, before: snapshot('', false), after: snapshot('one\ntwo\n') },
    { path: deletedPath, before: snapshot('gone\n'), after: snapshot('', false) },
  ];
  const files = buildFileChanges(mutations, process.cwd());
  const edited = files.find((file) => file.kind === 'modified');
  const added = files.find((file) => file.kind === 'added');
  const deleted = files.find((file) => file.kind === 'deleted');
  ok('turn mutations merge first preimage into final postimage', files.length === 3
    && edited.added === 1 && edited.removed === 1
    && edited.diff.some((line) => line.kind === 'del' && line.text === 'alpha')
    && edited.diff.some((line) => line.kind === 'add' && line.text === 'gamma'));
  ok('file change model counts new and deleted lines', added.added === 2 && deleted.removed === 1);
  ok('diff rows carry old and new line numbers', edited.diff.some((line) => line.kind === 'del' && line.oldLine === 1)
    && edited.diff.some((line) => line.kind === 'add' && line.newLine === 1));

  const changesApp = new App({ noSplash: true });
  changesApp.s = new Screen(new FakeOut(100, 40));
  changesApp.push({ role: 'user', text: 'change files', enter: 1 });
  changesApp.push({ role: 'approx', text: 'Done.', stopReason: 'stop', enter: 1 });
  const turn = {
    finalDelivered: true, promiseDone: true, runtimeSettled: true,
    interrupted: false, failed: false, releasing: false, mutations,
  };
  changesApp._activeTurn = turn;
  changesApp.tryReleaseTurn(turn);
  const changeset = changesApp.st.msgs.at(-1);
  changeset.enter = 1;
  ok('completed turn appends SYSTEM changes after final APPROX', changesApp.st.msgs.map((msg) => `${msg.role}:${msg.subtype || ''}`).join('|')
    === 'user:|approx:|system:changeset');
  ok('FILE CHANGES starts collapsed with aggregate counts', visibleLines(changeset, 80).length === 1
    && changeset.summary.files === 3 && changeset.summary.added === 3 && changeset.summary.removed === 2);
  changesApp.onKey({ name: 'u', ctrl: true });
  const keyboardExpanded = changeset.expanded;
  changeset.expandAnim.set(1, true);
  ok('keyboard expands focused FILE CHANGES', keyboardExpanded
    && visibleLines(changeset, 80).some((line) => line.kind === 'changediff'));
  changesApp.onKey({ name: 'u', ctrl: true });
  changesApp.st.scroll = 0;
  changesApp.st.scrollTarget = 0;
  changesApp.render(0);
  const vp = changesApp.viewport();
  const docTop = changesApp.st.msgs.slice(0, -1).reduce((sum, msg) => sum + totalHeight([msg], changesApp.bodyWidth()), 0);
  changesApp.onKey({ name: 'mousedown', mouse: true, x: vp.x + 4, y: vp.y + docTop + 1 });
  ok('clicking FILE CHANGES header expands it', changeset.expanded);

  const transcriptScreen = new Screen(new FakeOut(100, 40));
  transcriptScreen.clear(T.bg, T.fg);
  changeset.expandAnim.set(1, true);
  drawTranscript(transcriptScreen, [changeset], 0, 0, 100, 40, 0, 0);
  ok('new file uses green solid diff rail', transcriptScreen.ch.some((ch, index) => ch === '┃' && transcriptScreen.fg[index] === T.ok));
  ok('deleted file uses red dashed diff rail', transcriptScreen.ch.some((ch, index) => ch === '╎' && transcriptScreen.fg[index] === T.accent));
  const changeSnapshot = changesApp.snapshot().at(-1);
  ok('snapshot preserves expandable FILE CHANGES diff', changeSnapshot.subtype === 'changeset'
    && changeSnapshot.files.length === 3 && changeSnapshot.files[0].diff.length > 0);

  const quietApp = new App({ noSplash: true });
  quietApp.push({ role: 'user', text: 'read only', enter: 1 });
  quietApp.push({ role: 'approx', text: 'No edits.', stopReason: 'stop', enter: 1 });
  const quietTurn = {
    finalDelivered: true, promiseDone: true, runtimeSettled: true,
    interrupted: false, failed: false, releasing: false, mutations: [],
  };
  quietApp._activeTurn = quietTurn;
  quietApp.tryReleaseTurn(quietTurn);
  ok('read-only turn does not add an empty FILE CHANGES row', !quietApp.st.msgs.some((msg) => msg.subtype === 'changeset'));

  const editsApp = new App({ noSplash: true });
  editsApp.push({ role: 'user', text: 'edit a file' });
  editsApp.onBackendEvent({ type: 'assistant_start' });
  editsApp.onBackendEvent({ type: 'assistant_delta', delta: 'Applying edit' });
  editsApp.onBackendEvent({ type: 'assistant_end', text: 'Applying edit', stopReason: 'toolUse' });
  editsApp.onBackendEvent({ type: 'tool_start', id: 'live-edit', name: 'edit', title: 'Edit fixture' });
  ok('Write/Edit starts its own live File Edit child', editsApp.st.msgs.at(-1)?.role === 'workgroup'
    && editsApp.st.msgs.at(-1)?.fileEdits?.role === 'fileeditgroup'
    && editsApp.st.msgs.at(-1)?.tools?.length === 0);
  editsApp.onBackendEvent({ type: 'tool_end', id: 'live-edit', mutation: {
    path: 'FIXTURE', before: { exists: true, data: 'YQ==' }, after: { exists: true, data: 'Yg==' },
  } });
  const liveFileEdit = editsApp.st.msgs.at(-1)?.fileEdits;
  ok('live File Edit exposes the same diff rows before settlement', liveFileEdit?.files.length === 1
    && visibleLines(editsApp.st.msgs.at(-1), 80).some((line) => line.kind === 'changediff'));
  editsApp.clock.stop();

  const statusApp = new App({ noSplash: true });
  statusApp.s = new Screen(new FakeOut(96, 34));
  statusApp.recordUsageEvent({ inputTokens: 1200, outputTokens: 800, cacheReadTokens: 300, cost: 0.04, model: 'fixture-model', effort: 'high' });
  statusApp.openStatus();
  statusApp.st.status.anim.set(1, true);
  let finishStatusUpdate;
  statusApp._checkForUpdate = () => new Promise((resolve) => { finishStatusUpdate = resolve; });
  statusApp.statusKey({ name: 'u' });
  statusApp.render(0.4);
  ok('/status opens a paged dashboard with context and usage data', statusApp.st.status.open
    && statusApp.s.ch.join('').includes('CONTEXT WINDOW')
    && statusApp.s.ch.join('').includes('turns'));
  ok('/status update action renders its in-progress state',
    statusApp.s.ch.join('').includes('CHECKING FOR UPDATES'));
  finishStatusUpdate({ available: false, channel: 'npm', currentVersion: '1.2.0', version: '1.2.0' });
  await statusApp._updateCheck;
  statusApp.render(0.45);
  ok('/status update action retains its completed state',
    statusApp.s.ch.join('').includes('NPM 1.2.0 CURRENT'));
  ok('/status overview closes with a colophon and a throughput readout',
    statusApp.s.ch.join('').includes('SHEET 01')
    && statusApp.s.ch.join('').includes('THROUGHPUT'));
  statusApp.statusKey({ name: 'right' });
  ok('/status pages are keyboard navigable', statusApp.st.status.page === 1);
  statusApp.render(0.5);
  ok('/status activity sheet charts recent days above its colophon',
    statusApp.s.ch.join('').includes('TOKEN ACTIVITY')
    && statusApp.s.ch.join('').includes('SHEET 02'));
  statusApp.statusKey({ name: '3' });
  statusApp.render(0.6);
  const modelsFrame = statusApp.s.ch.join('');
  ok('/status models sheet names its split segments', modelsFrame.includes('MODEL SPLIT')
    && modelsFrame.includes('FIXTURE-MODEL') && !modelsFrame.includes('undefined'));
  statusApp.statusKey({ name: '4' });
  statusApp.render(0.7);
  ok('/status costs sheet reports session spend against lifetime',
    statusApp.s.ch.join('').includes('THIS SESSION')
    && statusApp.s.ch.join('').includes('SHEET 04'));
  const closeHit = statusApp.st.status.hits.find((hit) => hit.kind === 'close');
  ok('/status masthead exposes a clickable close region', !!closeHit
    && statusApp.statusPointer(closeHit.x1, closeHit.y) && !statusApp.st.status.open);
  statusApp.openStatus(0);
  statusApp.statusKey({ name: 'escape' });
  ok('/status closes without mutating the transcript', !statusApp.st.status.open && statusApp.st.msgs.length === 0);
  statusApp.clock.stop();
  changesApp.clock.stop();
  quietApp.clock.stop();
}

// ---- Git workbench status, operations, and responsive render ----
{
  const parsed = parseGitStatus('## main...origin/main [ahead 2, behind 1]\0 M src/a.js\0A  src/new.js\0R  src/to.js\0src/from.js\0?? loose.txt\0');
  ok('git status parser keeps branch divergence', parsed.branch.name === 'main'
    && parsed.branch.upstream === 'origin/main' && parsed.branch.ahead === 2 && parsed.branch.behind === 1);
  ok('git status parser splits worktree and staged lanes', parsed.worktree.length === 2 && parsed.staged.length === 2
    && parsed.staged.find((file) => file.mark === 'R')?.originalPath === 'src/from.js');

  const gitApp = new App({ noSplash: true });
  gitApp.s = new Screen(new FakeOut(100, 30));
  gitApp.st.git.anim.set(1, true);
  gitApp.st.git.branch = parsed.branch;
  gitApp.st.git.lanes = [parsed.worktree, parsed.staged];
  gitApp.st.git.commits = [{ hash: 'abc1234', subject: 'Make Git visual', age: 'now' }];
  gitApp.st.git.diffPath = 'src/a.js';
  gitApp.st.git.diff = [
    { kind: 'hunk', text: '@@ -1,1 +1,1 @@', oldLine: null, newLine: null },
    { kind: 'del', text: 'old', oldLine: 1, newLine: null },
    { kind: 'add', text: 'new', oldLine: null, newLine: 1 },
  ];
  gitApp.s.clear(T.bg, T.fg);
  drawGit(gitApp.s, gitApp.st, 0.4);
  const gitFrame = gitApp.s.ch.join('');
  ok('Git workbench renders lanes, index gate, and numbered diff', gitFrame.includes('WORKTREE')
    && gitFrame.includes('STAGED') && gitFrame.includes('INDEX') && gitFrame.includes('src/a.js'));
  ok('Git workbench translates untracked question marks into a green add marker', !gitFrame.includes('??')
    && gitFrame.includes('+  loose.txt'));
  ok('Git workbench exposes mouse targets', gitApp.st.git.hits.some((hit) => hit.kind === 'file')
    && gitApp.st.git.hits.some((hit) => hit.kind === 'gate') && gitApp.st.git.hits.some((hit) => hit.kind === 'commit'));
  let narrowGitThrew = false;
  try {
    const narrow = new Screen(new FakeOut(24, 9));
    narrow.clear(T.bg, T.fg);
    drawGit(narrow, gitApp.st, 0.6);
  } catch {
    narrowGitThrew = true;
  }
  ok('Git workbench renders in a narrow terminal', !narrowGitThrew);

  const repo = mkdtempSync(join(tmpdir(), 'approx-git-'));
  const run = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  run(['init', '-q']);
  run(['config', 'user.email', 'approx@example.test']);
  run(['config', 'user.name', 'Approx Test']);
  writeFileSync(join(repo, 'tracked.txt'), 'base\n', 'utf8');
  run(['add', 'tracked.txt']);
  gitApp.st.cwdPath = repo;
  await gitApp.refreshGit();
  ok('Git totals compare an initial repository against the empty tree', gitApp.st.git.branch.initial
    && gitApp.st.git.totals.added === 1 && gitApp.st.git.totals.removed === 0);
  run(['commit', '-q', '-m', 'base']);
  writeFileSync(join(repo, 'tracked.txt'), 'staged intermediate\n', 'utf8');
  run(['add', 'tracked.txt']);
  writeFileSync(join(repo, 'tracked.txt'), 'final worktree\n', 'utf8');
  gitApp.st.git.lane = 0;
  await gitApp.refreshGit();
  ok('Git refresh reads worktree diff', gitApp.st.git.lanes[0][0]?.path === 'tracked.txt'
    && gitApp.st.git.diff.some((line) => line.kind === 'add' && line.text === 'final worktree'));
  ok('Git totals count an MM file as one net change instead of summing both lanes',
    gitApp.st.git.lanes[1][0]?.path === 'tracked.txt'
    && gitApp.st.git.totals.added === 1 && gitApp.st.git.totals.removed === 1);
  await gitApp.gitStageAll();
  ok('Git stage-all moves changes through the index gate', gitApp.st.git.lanes[0].length === 0
    && gitApp.st.git.lanes[1][0]?.path === 'tracked.txt');
  await gitApp.gitUnstageAll();
  ok('Git unstage-all returns changes to worktree', gitApp.st.git.lanes[1].length === 0
    && gitApp.st.git.lanes[0][0]?.path === 'tracked.txt');

  // An untracked binary must reach the pane as a labelled meta line, never as
  // raw bytes decoded to mojibake. This is the read path that used to throw
  // outright because its binary/size helpers were missing.
  writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 128]));
  await gitApp.refreshGit();
  const binEntry = gitApp.st.git.lanes[0].find((file) => file.path === 'blob.bin');
  ok('Git reads an untracked binary without throwing', !!binEntry);
  gitApp.st.git.lane = 0;
  gitApp.st.git.selected[0] = gitApp.st.git.lanes[0].indexOf(binEntry);
  await gitApp.refreshGitDiff();
  ok('Git flags a binary file instead of piping bytes into the diff', gitApp.st.git.diffBinary
    && gitApp.st.git.diff[0]?.text?.startsWith('binary file'));
  rmSync(join(repo, 'blob.bin'), { force: true });

  // Selecting a stray build artifact must not read the entire file into the
  // TUI process. The pane should stop at the same size boundary used by totals.
  writeFileSync(join(repo, 'oversized.log'), Buffer.alloc(4 * 1024 * 1024 + 1, 97));
  await gitApp.refreshGit();
  const oversizedEntry = gitApp.st.git.lanes[0].find((file) => file.path === 'oversized.log');
  gitApp.st.git.lane = 0;
  gitApp.st.git.selected[0] = gitApp.st.git.lanes[0].indexOf(oversizedEntry);
  await gitApp.refreshGitDiff();
  ok('Git skips oversized untracked previews before reading their contents', !!oversizedEntry
    && !gitApp.st.git.diffLoading && gitApp.st.git.diff[0]?.text?.includes('preview skipped'));
  rmSync(join(repo, 'oversized.log'), { force: true });

  // Diff scroll must stop at the last full screen, not scroll a page of blank
  // rows past the end.
  gitApp.st.git.diff = Array.from({ length: 20 }, (_, i) => ({ kind: 'context', text: `line ${i}`, oldLine: i + 1, newLine: i + 1 }));
  gitApp.st.git.diffRows = 6;
  gitApp.st.git.diffScroll = 0;
  gitApp.gitScrollDiff(999);
  ok('Git diff scroll clamps to the last visible screen', gitApp.st.git.diffScroll === 14);

  // The discard flow is destructive, so it must route through a confirm prompt
  // and honour a "keep" answer by leaving the file untouched.
  writeFileSync(join(repo, 'tracked.txt'), 'discard me\n', 'utf8');
  await gitApp.refreshGit();
  gitApp.st.git.lane = 0;
  gitApp.st.git.selected[0] = gitApp.st.git.lanes[0].findIndex((file) => file.path === 'tracked.txt');
  const discardPromise = gitApp.gitDiscardSelected();
  ok('Git discard opens a confirmation questionnaire', gitApp.st.questionnaire.open
    && gitApp.st.questionnaire.title === 'DISCARD / CHANGES');
  gitApp.questionnaireKey({ name: 'enter' }); // default: keep the file
  gitApp.questionnaireKey({ name: 'enter' });
  await discardPromise;
  ok('Git discard keeps the file when confirmation is declined',
    readFileSync(join(repo, 'tracked.txt'), 'utf8').replace(/\r\n/g, '\n') === 'discard me\n');

  const discardPromise2 = gitApp.gitDiscardSelected();
  gitApp.questionnaireKey({ name: 'down' }); // move to "Discard changes"
  gitApp.questionnaireKey({ name: 'enter' });
  gitApp.questionnaireKey({ name: 'enter' });
  await discardPromise2;
  ok('Git discard restores tracked file contents when confirmed',
    readFileSync(join(repo, 'tracked.txt'), 'utf8').replace(/\r\n/g, '\n') === 'base\n');

  // The pane must never sit on the previous file's diff while the next read is
  // in flight: a selection change clears the pane synchronously and flags the
  // loading state, and only the newly selected file's content lands afterwards.
  writeFileSync(join(repo, 'tracked.txt'), 'stale\n', 'utf8');
  writeFileSync(join(repo, 'fresh.txt'), 'fresh\n', 'utf8');
  await gitApp.refreshGit();
  gitApp.st.git.lane = 0;
  gitApp.st.git.selected[0] = gitApp.st.git.lanes[0].findIndex((file) => file.path === 'fresh.txt');
  gitApp.frameRequested = false;
  const pendingDiff = gitApp.refreshGitDiff();
  ok('Git diff clears the pane the moment a selection changes', gitApp.st.git.diff.length === 0
    && gitApp.st.git.diffLoading && gitApp.st.git.diffPath === 'fresh.txt');
  await pendingDiff;
  ok('Git diff lands only the newly selected file', !gitApp.st.git.diffLoading
    && gitApp.st.git.diff.length > 0 && gitApp.st.git.diff.every((line) => line.text !== 'stale')
    && gitApp.st.git.diff.some((line) => line.kind === 'add' && line.text === 'fresh'));
  ok('Git diff completion requests a frame so the pane repaints without another keypress',
    gitApp.frameRequested);
  const pendingSame = gitApp.refreshGitDiff();
  ok('Git diff keeps the current file on screen when the same row refreshes',
    gitApp.st.git.diff.length > 0 && !gitApp.st.git.diffLoading);
  await pendingSame;
  ok('Git diff refresh of the same file keeps its content',
    gitApp.st.git.diff.some((line) => line.kind === 'add' && line.text === 'fresh'));

  // Hover latches the control under the pointer; the lane view records its
  // rectangle so a wheel event lands on the right list.
  writeFileSync(join(repo, 'tracked.txt'), 'hover\n', 'utf8');
  await gitApp.refreshGit();
  gitApp.s.clear(T.bg, T.fg);
  drawGit(gitApp.s, gitApp.st, 1);
  ok('Git lane view records its hit rectangle', !!gitApp.st.git.laneBox[0]);
  const commitHit = gitApp.st.git.hits.find((hit) => hit.kind === 'commit');
  gitApp.gitPointer(commitHit.x1, commitHit.y, false);
  ok('Git hover latches the control under the pointer', gitApp.st.git.hover?.kind === 'commit');

  rmSync(repo, { recursive: true, force: true });
  gitApp.clock.stop();
}

// ---- harness bridge: NDJSON drive ----
{
  class FakeIn {
    setEncoding() {}
    resume() {}
    on(ev, fn) { (this._h ??= {})[ev] = fn; }
    off() {}
    emit(ev, d) { this._h?.[ev]?.(d); }
  }
  const evs = [];
  const evOut = { write(s) { for (const l of s.split('\n')) if (l.trim()) evs.push(JSON.parse(l)); return true; } };
  const c = new App({ noSplash: true, harness: true });
  c.s = new Screen(new FakeOut(80, 24));
  c.seed();
  const fin = new FakeIn();
  const h = new Harness(c, { input: fin, out: evOut });
  c.attachHarness(h);
  const send = (o) => fin.emit('data', JSON.stringify(o) + '\n');
  const last = (evt) => [...evs].reverse().find((e) => e.event === evt);

  ok('harness announces ready', evs.some((e) => e.event === 'ready'));

  // attached backend: a submit emits needReply instead of running the script
  send({ cmd: 'attach' });
  ok('harness attaches', h.attached);
  send({ cmd: 'submit', text: 'drive me' });
  ok('harness submit lands a user turn', c.st.msgs.some((m) => m.role === 'user' && m.text === 'drive me'));
  ok('harness attached emits needReply', last('needReply')?.text === 'drive me');
  ok('harness attached suppresses scripted reply', !c.timers.size || ![...c.st.msgs].some((m) => m.streaming));

  // driver streams the reply; the real renderer runs it
  send({ cmd: 'say', text: 'a driven answer', cps: 2000 });
  ok('harness say begins a stream', c.st.msgs[c.st.msgs.length - 1].streaming);
  for (let i = 0; i < 120; i++) c.tick(1 / 30, i / 30, i);
  ok('harness stream finishes', last('streamEnd') != null);

  // set write-through echoes a setting event and mutates state
  send({ cmd: 'set', key: 'autoCompactMode', value: 'tokens' });
  ok('harness set applies', c.st.autoCompactMode === 'tokens' && last('setting')?.key === 'autoCompactMode');

  // tool injection runs and reports
  send({ cmd: 'tool', name: 'grep', meta: 'src', text: 'searching', dur: 60 });
  ok('harness tool pushes a running tool', c.st.msgs.some((m) => m.role === 'tool' && m.running));

  // snapshot + frame are pull-only introspection
  send({ cmd: 'snapshot' });
  ok('harness snapshot returns transcript', Array.isArray(last('snapshot')?.msgs));
  send({ cmd: 'frame', cols: 50, rows: 10 });
  const fr = last('frame');
  ok('harness frame dumps ansi at size', fr?.cols === 50 && fr?.rows === 10 && fr.ansi.length > 100);

  // bad json and unknown commands surface as errors, don't throw
  h.feed('{not json}\n');
  ok('harness bad json errors', last('error')?.message === 'bad json');
  send({ cmd: 'nope' });
  ok('harness unknown cmd errors', last('error')?.message.includes('nope'));

  send({ cmd: 'ping' });
  ok('harness ping pongs', last('pong') != null);

  // detach hands the backend back: submit runs the script again
  send({ cmd: 'detach' });
  ok('harness detaches', !h.attached);

  h.stop();
  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}
