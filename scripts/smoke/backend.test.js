import * as smoke from './shared.js';
import { sessionTranscript } from '../../src/backends/pi/helpers.js';

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

// ---- persisted Pi history restores File Edit bodies and FILE CHANGES chrome ----
{
  const cwd = process.cwd();
  const path = join(cwd, 'src', 'history-fixture.js');
  const history = sessionTranscript([
    {
      id: 'history-user', type: 'message', timestamp: Date.now(),
      message: { role: 'user', content: [{ type: 'text', text: 'repair history diff' }] },
    },
    {
      id: 'history-call', type: 'message', timestamp: Date.now(),
      message: {
        role: 'assistant', stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'Editing the history fixture.' },
          { type: 'toolCall', id: 'history-edit', name: 'edit', arguments: {
            path, edits: [{ oldText: 'old line', newText: 'new line' }],
          } },
        ],
      },
    },
    {
      id: 'history-result', type: 'message', timestamp: Date.now(),
      message: {
        role: 'toolResult', toolCallId: 'history-edit', toolName: 'edit', content: [],
        details: { patch: `--- ${path}\n+++ ${path}\n@@ -1 +1 @@\n-old line\n+new line\n` },
      },
    },
    {
      id: 'history-final', type: 'message', timestamp: Date.now(),
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'History repaired.' }] },
    },
  ], cwd);
  const app = new App({ noSplash: true });
  app.loadHistory(history);
  const work = app.st.msgs.find((message) => message.role === 'workgroup');
  const changeset = app.st.msgs.find((message) => message.role === 'system' && message.subtype === 'changeset');
  ok('history restores the File Edit file and diff rows', work?.fileEdits?.summary?.files === 1
    && work.fileEdits.summary.added === 1 && work.fileEdits.summary.removed === 1
    && work.fileEdits.files[0]?.diff.some((line) => line.kind === 'add' && line.text === 'new line'));
  work.fileEdits.expanded = true;
  work.fileEdits.expandAnim.set(1, true);
  const expandedEdit = visibleLines(work.fileEdits, 70);
  ok('restored File Edit expands into visible file and patch rows',
    expandedEdit.some((line) => line.kind === 'changefilehead')
    && expandedEdit.some((line) => line.kind === 'changediff' && line.text === 'new line'));
  ok('history restores the turn-level system changeset after the final answer', changeset?.summary?.files === 1
    && app.st.msgs.at(-1) === changeset);
  app.clock.stop();
  for (const id of app.timers) clearTimeout(id);
}

// ---- backend tool titles: model heading is consumed into the folded card ----
{
  const backend = new PiBackend();
  const events = [];
  backend.subscribe((event) => events.push(event));
  backend.onPiEvent({ type: 'agent_start' });
  backend.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } });
  backend.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '### Inspect renderer' } });
  backend.onPiEvent({
    type: 'message_end',
    message: {
      role: 'assistant', content: [{ type: 'text', text: '### Inspect renderer' }],
      stopReason: 'toolUse', usage: { output: 4 },
    },
  });
  backend.onPiEvent({ type: 'tool_execution_start', toolCallId: 'named-1', toolName: 'read', args: { path: 'src/screen.js' } });
  const end = events.find((event) => event.type === 'assistant_end');
  const start = events.find((event) => event.type === 'tool_start');
  ok('model tool heading is hidden from answer', end?.text === '');
  ok('model tool heading names card', start?.title === 'Inspect renderer' && start.modelTitle === true);

  const integrated = new App({ noSplash: true, backend });
  backend.onPiEvent({ type: 'agent_start' });
  backend.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } });
  backend.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '### Inspect input routing' } });
  backend.onPiEvent({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: '### Inspect input routing' }], stopReason: 'toolUse' },
  });
  backend.onPiEvent({ type: 'tool_execution_start', toolCallId: 'named-2', toolName: 'read', args: { path: 'src/input.js' } });
  ok('empty authoritative answer removes streamed naming heading', !integrated.st.msgs.some((msg) => msg.role === 'approx'));
  ok('consumed heading lands only on its tool card', integrated.st.msgs.at(-1)?.title === 'Inspect input routing');
  integrated.backendUnsubscribe?.();
  integrated.clock.stop();
}

// ---- backend batch heading names a future 3+ tool group ----
{
  const backend = new PiBackend();
  const events = [];
  backend.subscribe((event) => events.push(event));
  const heading = '### Tool Calls: Audit renderer pipeline\n### Read compositor';
  backend.onPiEvent({ type: 'agent_start' });
  backend.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } });
  backend.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: heading } });
  backend.onPiEvent({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: heading }], stopReason: 'toolUse' },
  });
  backend.onPiEvent({ type: 'tool_execution_start', toolCallId: 'batch-1', toolName: 'read', args: { path: 'src/screen.js' } });
  const end = events.find((event) => event.type === 'assistant_end');
  const start = events.find((event) => event.type === 'tool_start');
  ok('model batch heading is hidden from answer', end?.text === '');
  ok('model batch heading names group level', start?.groupTitle === 'Audit renderer pipeline'
    && start?.groupHeading === 'Tool Calls: Audit renderer pipeline' && start.modelGroupTitle === true);
  ok('batch heading does not replace child title', start?.title === 'Read compositor' && start.modelTitle === true);
}

// A provider that puts titles only in thinking (or omits them) still gets useful
// deterministic action names from the host adapter.
{
  const backend = new PiBackend();
  const events = [];
  backend.subscribe((event) => events.push(event));
  backend.onPiEvent({ type: 'agent_start' });
  backend.onPiEvent({
    type: 'tool_execution_start', toolCallId: 'fallback-find', toolName: 'bash',
    args: { command: 'cd "C:/work/Approx" && find . -type f -not -path "*/node_modules/*"' },
  });
  backend.onPiEvent({
    type: 'tool_execution_start', toolCallId: 'fallback-wc', toolName: 'shell',
    args: { command: 'cd "C:/work/Approx" && echo "files" && wc -l src/*.js' },
  });
  const titles = events.filter((event) => event.type === 'tool_start').map((event) => event.title);
  ok('missing model headings get intent-based tool names', titles.join('|') === 'List project files|Count project lines');
}

// Duplicate visible prompts resolve by ordinal position, never by the last-text fallback.
{
  const backend = new PiBackend();
  backend.session = {
    getUserMessagesForForking: () => [
      { entryId: 'first-same', text: 'same prompt' },
      { entryId: 'second-same', text: 'same prompt' },
    ],
  };
  ok('rewind targets duplicate prompt by visible ordinal', backend.resolveUserEntryAt(0, 'same prompt') === 'first-same'
    && backend.resolveUserEntryAt(1, 'same prompt') === 'second-same');
}

// `/clear` reuses the active session object and rebuilds its live context; `/new`
// is the only path that disposes it and opens another persisted session.
{
  const backend = new PiBackend();
  const overrides = [];
  backend.session = {
    model: { contextWindow: 128000 },
    settingsManager: {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }),
      applyOverrides: (value) => overrides.push(value),
    },
  };
  const percent = backend.setAutoCompactThreshold({ mode: 'percent', percent: 10, tokens: 32768 });
  ok('percent compact threshold maps onto native Pi reserve', percent.thresholdTokens === 12800
    && overrides.at(-1).compaction.reserveTokens === 115200
    && overrides.at(-1).compaction.keepRecentTokens === 6400);
  const tokens = backend.setAutoCompactThreshold({ mode: 'tokens', percent: 80, tokens: 65536 });
  ok('token compact threshold maps onto native Pi reserve', tokens.thresholdTokens === 65536
    && overrides.at(-1).compaction.reserveTokens === 62464
    && overrides.at(-1).compaction.keepRecentTokens === 20000);
}

{
  const backend = new PiBackend();
  let instructions = null;
  backend.session = {
    compact: async (value) => { instructions = value; return { tokensBefore: 64000, estimatedTokensAfter: 12000 }; },
    getContextUsage: () => null,
  };
  const result = await backend.compact('preserve exact paths');
  ok('manual compact delegates to AgentSession', instructions === 'preserve exact paths'
    && result.estimatedTokensAfter === 12000);
}

{
  const c = new App({ noSplash: true });
  c.s = new Screen(new FakeOut(90, 30));
  c.st.contextWindow = 128000;
  c.st.ctxTokens = 96000;
  c.onBackendEvent({ type: 'compaction_start', reason: 'threshold' });
  ok('compact start arms takeover state', c.st.compact.phase === 'running'
    && c.st.compact.enter.target === 1 && c.st.busy);
  c.onBackendEvent({
    type: 'compaction_end', reason: 'threshold', tokensBefore: 96000, estimatedTokensAfter: 18000,
  });
  ok('compact end lands token estimate and releases idle app', c.st.compact.phase === 'done'
    && c.st.compact.tokensAfter === 18000 && Math.abs(c.st.ctxUse.target - 18000 / 128000) < 0.001
    && !c.st.busy);
  c.st.compact.enter.set(1, true);
  c.st.compact.phase = 'running';
  drawCompact(c.s, c.st, 1.5);
  ok('compact progress stays on the primary signal palette', !Array.from(c.s.fg).includes(T.accent2));
  ok('compact veil fully hides transcript outside the panel', c.s.fg[0] === c.s.bg[0]);
  c.st.compact.phase = 'done';
  drawCompact(c.s, c.st, 1.5);
  const compactFrame = c.s.ch.join('');
  ok('compact overlay omits pi link status text', !compactFrame.includes('PI LINK')
    && compactFrame.includes('96K TOK') && compactFrame.includes('18K TOK'));
  const previousAccent = c.st.accent;
  c.setAccent(3);
  c.st.compact.progress.set(1, true);
  c.s.clear(T.bg, T.fg);
  drawCompact(c.s, c.st, 1.5);
  const compactColors = Array.from(c.s.fg);
  ok('compact completion follows the selected accent instead of fixed success green',
    compactColors.includes(T.accent) && !compactColors.includes(T.ok));
  c.setAccent(previousAccent);
  let compactThrew = null;
  try {
    c.s.resize(24, 8);
    drawCompact(c.s, c.st, 2);
  } catch (error) { compactThrew = error; }
  ok('compact takeover renders at full and tiny sizes', !compactThrew);
  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}

{
  const backend = new PiBackend();
  let resetLeaf = 0;
  const manager = {
    resetLeaf() { resetLeaf++; },
    buildSessionContext() { return { messages: [] }; },
  };
  const oldSession = {
    isStreaming: false,
    sessionId: 'same-session',
    sessionManager: manager,
    agent: { state: { messages: ['stale'] } },
    getUserMessagesForForking: () => [],
    getContextUsage: () => null,
    model: { provider: 'test', id: 'model-a' },
    thinkingLevel: 'medium',
    dispose() {},
  };
  backend.session = oldSession;
  await backend.resetContext();
  ok('clear rebuilds current live context', resetLeaf === 1 && backend.session === oldSession
    && oldSession.agent.state.messages.length === 0);
  const newSession = { sessionId: 'different-session', sessionFile: 'new.json' };
  backend.openSession = async () => { backend.session = newSession; return newSession; };
  await backend.newConversation();
  ok('new opens a distinct conversation session', backend.session === newSession && backend.session !== oldSession);
}

{
  const backend = new PiBackend();
  let leaf = 'assistant-after-target';
  const target = { id: 'target-user', parentId: 'assistant-before-target', type: 'message', message: { role: 'user' } };
  const prior = {
    id: 'assistant-before-target', type: 'message',
    message: {
      role: 'assistant', content: 'prior',
      details: {
        plan: {
          mode: 'plan', intent: 'Plan before the edited turn', approval: 'pending',
          todos: [{ id: 'before-edit', text: 'Keep the old branch plan', status: 'pending' }],
        },
      },
    },
  };
  const manager = {
    getEntry: (id) => id === target.id ? target : id === prior.id ? prior : { id: leaf },
    getLeafId: () => leaf,
    getBranch: () => [prior],
    buildSessionContext: () => ({ messages: [{ role: 'assistant', content: 'prior' }] }),
  };
  backend.session = {
    isStreaming: false,
    sessionManager: manager,
    agent: { state: { messages: [{ role: 'user', content: 'old prompt' }, { role: 'assistant', content: 'old answer' }] } },
    navigateTree: async () => { leaf = prior.id; return { cancelled: false }; },
    getContextUsage: () => null,
  };
  await backend.rewindContext(target.id);
  ok('rewind rebuilds model context before edited user turn', leaf === prior.id
    && backend.session.agent.state.messages.length === 1
    && backend.session.agent.state.messages[0].content === 'prior');
  ok('rewind restores the Plan snapshot from the destination branch', backend.planState.intent === 'Plan before the edited turn'
    && backend.planState.todos[0]?.id === 'before-edit');
}

{
  const backend = new PiBackend();
  let leaf = 'after-leaf';
  const target = {
    id: 'branch-target', parentId: 'before-leaf', type: 'message', message: { role: 'user' },
  };
  const entries = new Map([
    [target.id, target],
    ['before-leaf', { id: 'before-leaf', type: 'custom', data: {
      plan: { mode: 'plan', intent: 'Before branch', approval: 'pending', todos: [] },
    } }],
    ['after-leaf', { id: 'after-leaf', type: 'custom', data: {
      plan: { mode: 'plan', intent: 'After branch', approval: 'pending', todos: [] },
    } }],
  ]);
  const manager = {
    getEntry: (id) => entries.get(id),
    getLeafId: () => leaf,
    getBranch: () => [entries.get(leaf)],
  };
  backend.session = {
    isStreaming: false,
    sessionManager: manager,
    navigateTree: async (id) => {
      leaf = id === target.id ? target.parentId : id;
      return { cancelled: false };
    },
    getContextUsage: () => null,
  };
  const token = await backend.rewindContext(target.id);
  const rewoundIntent = backend.planState.intent;
  await backend.redoRewind(token);
  ok('rewind and redo restore their respective Plan branches', rewoundIntent === 'Before branch'
    && backend.planState.intent === 'After branch');
}

// ---- backend snapshots Write/Edit and restores both sides of one branch ----
{
  const dir = mkdtempSync(join(tmpdir(), 'approx-rewind-'));
  const file = join(dir, 'fixture.txt');
  writeFileSync(file, 'before', 'utf8');
  const backend = new PiBackend({ cwd: dir });
  const events = [];
  const persisted = [];
  backend.session = {
    sessionManager: {
      appendCustomEntry(type, data) { persisted.push({ type, data }); },
    },
  };
  backend.subscribe((event) => events.push(event));
  backend.onPiEvent({ type: 'tool_execution_start', toolCallId: 'edit-1', toolName: 'edit', args: { path: file } });
  writeFileSync(file, 'after', 'utf8');
  backend.onPiEvent({
    type: 'tool_execution_end', toolCallId: 'edit-1', result: { content: [] }, isError: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const mutation = events.find((event) => event.type === 'tool_end')?.mutation;
  ok('backend captures edit preimage and postimage', mutation?.before?.exists && mutation?.after?.exists
    && Buffer.from(mutation.before.data, 'base64').toString() === 'before'
    && Buffer.from(mutation.after.data, 'base64').toString() === 'after');
  ok('backend persists a lightweight file-change record for future history loads',
    persisted[0]?.type === 'approx-file-changes' && persisted[0].data.callId === 'edit-1'
    && persisted[0].data.fileChanges[0]?.added === 1 && persisted[0].data.fileChanges[0]?.removed === 1
    && !('before' in persisted[0].data.fileChanges[0]));

  const entries = new Map([
    ['user-entry', { id: 'user-entry', type: 'message', message: { role: 'user' } }],
    ['old-leaf', { id: 'old-leaf', type: 'message', message: { role: 'assistant' } }],
  ]);
  backend.session = {
    isStreaming: false,
    sessionManager: { getEntry: (id) => entries.get(id), getLeafId: () => 'old-leaf' },
    navigateTree: async () => ({ cancelled: false, editorText: 'fixture prompt' }),
    getContextUsage: () => null,
  };
  const token = await backend.rewindContext('user-entry', [mutation], ['edit-1']);
  ok('rewind restores file preimage', readFileSync(file, 'utf8') === 'before' && token.oldLeafId === 'old-leaf');
  await backend.redoRewind(token, [mutation]);
  ok('redo restores file postimage', readFileSync(file, 'utf8') === 'after');

  const delivery = new App({ noSplash: true, backend });
  delivery.s = new Screen(new FakeOut(90, 28));
  delivery.push({ role: 'user', text: 'edit through Pi', enter: 1 });
  delivery.push({ role: 'approx', text: 'done', stopReason: 'stop', enter: 1 });
  const deliveryTurn = {
    finalDelivered: true, promiseDone: true, runtimeSettled: true,
    interrupted: false, failed: false, releasing: false,
    mutations: [], mutationCallIds: ['edit-1'],
  };
  delivery._activeTurn = deliveryTurn;
  delivery.tryReleaseTurn(deliveryTurn);
  ok('delivery boundary recovers Pi mutations by tool call id', delivery.st.msgs.at(-1)?.subtype === 'changeset'
    && delivery.st.msgs.at(-1)?.summary?.files === 1);
  delivery.backendUnsubscribe?.();
  delivery.clock.stop();
  rmSync(dir, { recursive: true, force: true });
}
