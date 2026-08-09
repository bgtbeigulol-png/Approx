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
// ---- edit/retry rewind, one-step redo, and terminal-style selection ----
{
  const out = new FakeOut(88, 28);
  const c = new App({ noSplash: true });
  c.s = new Screen(out);
  c.push({ role: 'system', text: 'session ready', enter: 1 });
  const user = c.push({ role: 'user', text: 'original request', enter: 1 });
  c.push({ role: 'approx', text: 'old answer', enter: 1 });
  c.push({
    role: 'tool', name: 'edit', title: 'Edit fixture', text: 'done', enter: 1,
    mutation: { kind: 'edit', path: 'FIXTURE', before: { exists: true, data: 'YQ==' }, after: { exists: true, data: 'Yg==' } },
  });
  c.push({ role: 'approx', text: 'old follow-up', enter: 1 });
  c.update(1 / 30, 0);
  c.render(0);

  c.onKey({ name: 'e', ctrl: true });
  ok('ctrl-e selects latest user turn first', c.st.messageEdit.mode === 'selected' && c.st.messageEdit.target === user);
  c.onKey({ name: 'e', ctrl: true });
  ok('second ctrl-e loads message into editor', c.st.messageEdit.mode === 'editing' && c.st.input === user.text);
  c.onKey({ name: 'enter' });
  ok('unchanged edit opens retry confirmation', c.st.messageEdit.mode === 'confirm'
    && c.st.messageEdit.messageCount === 4 && c.st.messageEdit.mutationCount === 1);
  for (let i = 0; i < 20; i++) c.update(1 / 60, i / 60);
  c.render(0.35);
  ok('rewind confirmation renders its animated label', c.s.ch.join('').includes('REWIND?'));
  c.onKey({ name: 'n', printable: true });
  ok('rewind no keeps editable draft', c.st.messageEdit.mode === 'editing' && c.st.input === user.text);
  c.onKey({ name: 'enter' });
  c.onKey({ name: 'y', printable: true });
  const retry = c.st.msgs.at(-1);
  ok('rewind replaces suffix with retry turn', c.st.msgs.length === 2 && retry.role === 'user'
    && retry.text === user.text && retry.redoAvailable === true);
  c.update(1 / 30, 0.1);
  c.render(0.1);
  ok('retry turn exposes a rendered redo hit target', retry._redoHit?.x2 >= retry._redoHit?.x1);
  c.onKey({ name: 'r', alt: true });
  ok('alt-r restores abandoned branch once', c.st.msgs.length === 5 && c.st.msgs[1] === user && c.st.redo === null);

  // Double click selects on the first press and enters edit on the second.
  c.st.wipe = 0;
  c.scrollTo(0);
  c.st.scrollSpring.set(0, true);
  c.render(0.2);
  const vp = c.viewport();
  const uy = vp.y + 4; // system occupies three rows; next header is the user turn
  c.onKey({ name: 'mousedown', mouse: true, x: vp.x + 5, y: uy });
  ok('first user click shows selection state', c.st.messageEdit.mode === 'selected');
  c.onKey({ name: 'mousedown', mouse: true, x: vp.x + 5, y: uy });
  ok('double click enters user edit', c.st.messageEdit.mode === 'editing');
  c.cancelMessageEdit();

  // Dragging across a rendered transcript row highlights and copies with OSC 52.
  c.render(0.3);
  const bodyY = uy;
  c.onKey({ name: 'mousedown', mouse: true, x: vp.x + 3, y: bodyY });
  c.onKey({ name: 'mousedrag', mouse: true, dragging: true, x: vp.x + 11, y: bodyY });
  c.onKey({ name: 'mouseup', mouse: true, x: vp.x + 11, y: bodyY });
  ok('mouse drag retains a visible selection', c.st.textSelection && c.st.textSelection.active === false);
  ok('mouse release copies selection with osc52', out.buf.includes('\x1b]52;c;'));

  // Selection tint changes the visual background, but decorative paper grain
  // remains absent from copied text while a real middle dot survives.
  const copyY = vp.y;
  const copyX = vp.x + 3;
  c.s.put(copyX, copyY, '·', T.dim, T.bg, 0, ' ');
  c.s.put(copyX + 1, copyY, '·', T.fg, T.bg);
  c.s.tint(copyX, copyY, undefined, T.accent);
  c.s.tint(copyX + 1, copyY, undefined, T.accent);
  c.st.textSelection = {
    anchor: { x: copyX, y: copyY },
    focus: { x: copyX + 1, y: copyY },
    active: false,
  };
  ok('copy omits tinted paper grain but preserves a real middle dot', c.selectedScreenText() === '·');

  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}

// ---- history replacement clears state owned by the previous conversation ----
{
  const c = new App({ noSplash: true });
  c.s = new Screen(new FakeOut(88, 28));
  c.st.redo = { used: false };
  c.st.textSelection = { active: true };
  c.st.jump = true;
  c.st.railTicks = [{ index: 99 }];
  c.st.railHover = 3;
  c._tokenEvents = [{ at: 1, tokens: 2 }];
  c.loadHistory([{ role: 'user', text: 'replacement history' }]);
  ok('history replacement clears stale redo and transcript interaction state',
    c.st.redo === null && c.st.textSelection === null && !c.st.jump
    && c.st.railTicks.length === 0 && c.st.railHover === -1 && c._tokenEvents.length === 0);
  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}

// ---- three adjacent tools become one named, two-level group ----
{
  const c = new App({ noSplash: true });
  c.s = new Screen(new FakeOut(90, 28));
  const starts = [
    { id: 'g-1', name: 'read', title: 'Read package.json', groupTitle: 'Inspect project structure', modelGroupTitle: true },
    { id: 'g-2', name: 'read', title: 'Read app.js' },
    { id: 'g-3', name: 'grep', title: 'Search tool routing' },
  ];
  const nestedTools = [...toolMessages({
    role: 'workgroup', tools: [{
      role: 'toolgroup', tools: [{ role: 'tool', callId: 'a' }, { role: 'tool', callId: 'b' }],
    }],
  })];
  ok('shared tool-tree walk returns nested leaf tools in display order',
    nestedTools.map((tool) => tool.callId).join('|') === 'a|b');
  c.onBackendEvent({ type: 'tool_start', ...starts[0] });
  c.onBackendEvent({ type: 'tool_start', ...starts[1] });
  ok('two adjacent tools stay independent', c.st.msgs.length === 2 && c.st.msgs.every((msg) => msg.role === 'tool'));
  c.onBackendEvent({ type: 'tool_start', ...starts[2] });
  const group = c.st.msgs[0];
  ok('third adjacent tool creates one group', c.st.msgs.length === 1 && group.role === 'toolgroup' && group.tools.length === 3);
  ok('tool group keeps model batch title', group.title === 'Inspect project structure' && group.modelTitle === true);
  ok('tool group starts folded', !group.expanded && visibleLines(group, 70).length === 1);

  c.onBackendEvent({ type: 'tool_update', id: 'g-2', text: 'app body' });
  c.onBackendEvent({ type: 'tool_end', id: 'g-1', text: 'package body', isError: false });
  c.onBackendEvent({ type: 'tool_end', id: 'g-2', text: 'app body', isError: false });
  c.onBackendEvent({ type: 'tool_end', id: 'g-3', text: 'grep failed', isError: true });
  ok('grouped live tools still update in place', group.tools[1].text === 'app body' && group.tools[2].isError === true);

  const folded = totalHeight([group], 70);
  c.toggleToolGroup(group);
  for (let i = 0; i < 40; i++) c.update(1 / 30, i / 30);
  ok('first level reveals child summaries', visibleLines(group, 70).filter((line) => line.kind === 'toolchildhead').length === 3
    && totalHeight([group], 70) > folded);
  c.toggleTool(group.tools[1]);
  for (let i = 0; i < 40; i++) c.update(1 / 30, i / 30);
  ok('second level reveals one child output', visibleLines(group, 70).some((line) => line.kind === 'toolchildbody' && line.tool === group.tools[1]));

  const snap = c.snapshot()[0];
  ok('snapshot preserves grouped tool structure', snap.role === 'toolgroup' && snap.tools.length === 3 && snap.title === group.title);

  // Keyboard expansion walks from the outer group to its latest child.
  group.tools.forEach((tool) => { tool.expanded = false; tool.expandAnim.set(0, true); });
  group.expanded = false;
  group.expandAnim.set(0, true);
  c.st.toolFocus = group.callId;
  c.toggleFocusedTool();
  ok('ctrl-u opens group level first', group.expanded && c.st.toolFocus === group.tools.at(-1).callId);
  c.toggleFocusedTool();
  ok('ctrl-u then opens focused child level', group.tools.at(-1).expanded === true);

  // Pointer hit-testing resolves the nested row, not just the outer message.
  group.expanded = true;
  group.expandAnim.set(1, true);
  group.tools[0].expanded = false;
  group.tools[0].expandAnim.set(0, true);
  c.st.scroll = 0;
  c.st.scrollTarget = 0;
  const vp = c.viewport();
  c.onKey({ name: 'mousedown', mouse: true, x: vp.x + 8, y: vp.y + 2 });
  ok('click opens a nested tool row', group.tools[0].expanded === true && group.expanded === true);
  c.onKey({ name: 'mousedown', mouse: true, x: vp.x + 8, y: vp.y + 1 });
  ok('click on group bar folds outer level', group.expanded === false);

  const promotedApp = new App({ noSplash: true });
  promotedApp.onBackendEvent({
    type: 'tool_start', id: 'p-1', name: 'bash', title: 'Measure repository scale',
    fallbackTitle: 'Run project metrics', modelTitle: true,
  });
  promotedApp.onBackendEvent({ type: 'tool_start', id: 'p-2', name: 'bash', title: 'Run line count', fallbackTitle: 'Run line count' });
  promotedApp.onBackendEvent({ type: 'tool_start', id: 'p-3', name: 'bash', title: 'Run file count', fallbackTitle: 'Run file count' });
  const promoted = promotedApp.st.msgs[0];
  ok('first model heading is promoted when a 3-call batch omitted its prefix', promoted.role === 'toolgroup'
    && promoted.title === 'Measure repository scale' && promoted.modelTitle === true);
  ok('promoted batch title no longer duplicates first child', promoted.tools[0].title === 'Run project metrics');

  // Final delivery archives an interleaved work phase into a three-level tree.
  const archived = new App({ noSplash: true });
  archived.s = new Screen(new FakeOut(90, 28));
  archived.push({ role: 'user', text: 'archive this turn' });
  archived.push({ role: 'approx', text: 'I am checking the files', stopReason: 'toolUse' });
  archived.push({ role: 'tool', name: 'read', title: 'Read app.js', text: 'source' });
  archived.push({ role: 'approx', text: 'One more pass', stopReason: 'toolUse' });
  archived.push({ role: 'tool', name: 'grep', title: 'Search routes', text: 'matches' });
  archived.push({ role: 'approx', text: 'Final answer', stopReason: 'stop' });
  ok('final delivery creates one WORK archive', archived.archiveCompletedWork()
    && archived.st.msgs.map((msg) => msg.role).join('|') === 'user|workgroup|approx');
  const work = archived.st.msgs[1];
  ok('WORK archive keeps notes and one Tool Calls parent', work.notes.length === 2
    && work.tools.length === 1 && work.tools[0].role === 'toolgroup');
  ok('Tool Calls parent keeps every child call', work.tools[0].tools.length === 2);
  work.expanded = true;
  work.expandAnim.set(1, true);
  work.tools[0].expanded = true;
  work.tools[0].expandAnim.set(1, true);
  ok('three-level archive renders note, parent, and child rows', visibleLines(work, 70).some((line) => line.kind === 'worknote')
    && visibleLines(work, 70).some((line) => line.kind === 'worktoolhead')
    && visibleLines(work, 70).filter((line) => line.kind === 'toolchildhead').length === 2);
  const archivedSnap = archived.snapshot()[1];
  ok('snapshot preserves archived work hierarchy', archivedSnap.role === 'workgroup'
    && archivedSnap.notes.length === 2 && archivedSnap.tools[0].tools.length === 2);

  const silent = new App({ noSplash: true });
  silent.push({ role: 'user', text: 'tool-only turn' });
  silent.push({ role: 'tool', name: 'read', title: 'Read file' });
  silent.push({ role: 'approx', text: 'done', stopReason: 'stop' });
  silent.archiveCompletedWork();
  ok('tool-only archive gets a deterministic fallback Note', silent.st.msgs[1]?.notes?.[0]?.synthetic === true);
  silent.clock.stop();
  for (const id of silent.timers) clearTimeout(id);

  const staged = new App({ noSplash: true });
  staged.push({ role: 'user', text: 'multi-stage turn' });
  staged.onBackendEvent({ type: 'assistant_start' });
  staged.onBackendEvent({ type: 'assistant_delta', delta: 'stage one' });
  staged.onBackendEvent({ type: 'assistant_end', text: 'stage one', stopReason: 'stop' });
  staged.onBackendEvent({ type: 'tool_start', id: 'stage-read', name: 'read', title: 'Read file' });
  staged.onBackendEvent({ type: 'tool_end', id: 'stage-read', text: 'ok' });
  staged.onBackendEvent({ type: 'assistant_start' });
  staged.onBackendEvent({ type: 'assistant_delta', delta: 'final' });
  staged.onBackendEvent({ type: 'assistant_end', text: 'final', stopReason: 'stop' });
  ok('assistant progress is not archived before backend settlement', staged.st.msgs.some((msg) => msg.role === 'tool'));
  staged.onBackendEvent({ type: 'settled' });
  ok('settlement folds every stage into one WORK', staged.st.msgs.map((msg) => msg.role).join('|') === 'user|workgroup|approx'
    && staged.st.msgs[1].notes[0].text === 'stage one');
  staged.clock.stop();
  for (const id of staged.timers) clearTimeout(id);

  // A phase-level settlement may arrive before the request promise resolves.
  // Keep every later note/tool flat until the actual turn boundary is complete.
  class DeferredArchiveBackend {
    constructor() { this.listeners = new Set(); this.resolvePrompt = null; }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(event) { for (const fn of this.listeners) fn(event); }
    prompt() { return new Promise((resolve) => { this.resolvePrompt = resolve; }); }
    dispose() {}
  }
  const deferredBackend = new DeferredArchiveBackend();
  const deferred = new App({ noSplash: true, backend: deferredBackend });
  deferred.s = new Screen(new FakeOut(90, 28));
  deferred.submitText('keep every work phase together');
  deferredBackend.emit({ type: 'assistant_start' });
  deferredBackend.emit({ type: 'assistant_delta', delta: 'first progress note' });
  deferredBackend.emit({ type: 'assistant_end', text: 'first progress note', stopReason: 'toolUse' });
  deferredBackend.emit({ type: 'tool_start', id: 'deferred-read', name: 'read', title: 'Read file' });
  deferredBackend.emit({ type: 'tool_end', id: 'deferred-read', text: 'ok' });
  deferredBackend.emit({ type: 'assistant_start' });
  deferredBackend.emit({ type: 'assistant_delta', delta: 'middle progress note' });
  deferredBackend.emit({ type: 'assistant_end', text: 'middle progress note', stopReason: 'stop' });
  deferredBackend.emit({ type: 'tool_start', id: 'deferred-grep', name: 'grep', title: 'Search project' });
  deferredBackend.emit({ type: 'tool_end', id: 'deferred-grep', text: 'ok' });
  deferredBackend.emit({ type: 'settled' });
  ok('phase-level settlement leaves WORK open for later tool activity', !deferred.st.msgs.some((msg) => msg.role === 'workgroup'));
  deferredBackend.emit({ type: 'assistant_start' });
  deferredBackend.emit({ type: 'assistant_delta', delta: 'final result' });
  deferredBackend.emit({ type: 'assistant_end', text: 'final result', stopReason: 'stop' });
  deferredBackend.resolvePrompt();
  await new Promise((resolve) => setImmediate(resolve));
  ok('completed turn archives every earlier phase under one WORK', deferred.st.msgs.map((msg) => msg.role).join('|') === 'user|workgroup|approx'
    && deferred.st.msgs[1].notes.length === 2 && deferred.st.msgs[1].tools[0].tools.length === 2);
  deferred.backendUnsubscribe?.();
  deferred.clock.stop();
  for (const id of deferred.timers) clearTimeout(id);

  const repaired = new App({ noSplash: true });
  repaired.push({ role: 'user', text: 'repair a partially archived turn' });
  repaired.push({ role: 'workgroup', title: 'Work', notes: [{ role: 'approx', text: 'old stage' }], tools: [
    { role: 'toolgroup', title: 'Tool Calls', tools: [{ role: 'tool', name: 'read', title: 'Old call' }] },
  ] });
  repaired.push({ role: 'approx', text: 'later stage', stopReason: 'stop' });
  repaired.push({ role: 'tool', name: 'grep', title: 'Later call' });
  repaired.push({ role: 'approx', text: 'final', stopReason: 'stop' });
  repaired.archiveCompletedWork();
  ok('partial archive self-repairs into one WORK', repaired.st.msgs.map((msg) => msg.role).join('|') === 'user|workgroup|approx'
    && repaired.st.msgs[1].notes.length === 2 && repaired.st.msgs[1].tools[0].tools.length === 2);
  repaired.clock.stop();
  for (const id of repaired.timers) clearTimeout(id);

  archived.clock.stop();
  for (const id of archived.timers) clearTimeout(id);

  promotedApp.clock.stop();

  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}
