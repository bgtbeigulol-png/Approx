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
// ---- prompt queue: structured final delivery, deletion, and deferred runtime ----
{
  class QueueBackend {
    constructor() { this.listeners = new Set(); this.prompts = []; this.aborts = 0; this.models = []; this.efforts = []; }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(event) { for (const fn of this.listeners) fn(event); }
    prompt(text) { this.prompts.push(text); return Promise.resolve(); }
    abort() { this.aborts++; return Promise.resolve(); }
    setModel(model) { this.models.push(model); this.emit({ type: 'model', model }); return Promise.resolve(); }
    setEffort(effort) { this.efforts.push(effort); this.emit({ type: 'effort', effort }); return effort; }
    dispose() {}
  }
  const backend = new QueueBackend();
  const c = new App({ noSplash: true, backend });
  c.s = new Screen(new FakeOut(88, 28));
  c.st.modelOptions = [{ provider: 'test', id: 'a', label: 'a' }, { provider: 'test', id: 'b', label: 'b' }];
  c.st.model = 'a';
  c.st.effortOptions = ['low', 'high'];
  c.st.effort = 'low';

  c.submitText('first request');
  c.submitText('second request');
  c.submitText('third request');
  ok('busy submits stay out of transcript and context in FIFO queue', backend.prompts.join('|') === 'first request'
    && c.st.messageQueue.map((item) => item.text).join('|') === 'second request|third request'
    && c.st.msgs.filter((msg) => msg.role === 'user').length === 1);

  // Hidden continuations (such as approved Plan execution) have no App turn
  // envelope. Pi remains authoritative during the brief gap around a WORK note.
  const runtimeBackend = new QueueBackend();
  runtimeBackend.runtimeBusy = true;
  runtimeBackend.isBusy = () => runtimeBackend.runtimeBusy;
  const runtimeQueued = new App({ noSplash: true, backend: runtimeBackend });
  runtimeQueued.submitText('queued during work note');
  ok('runtime-active WORK note always accepts a queued prompt', runtimeBackend.prompts.length === 0
    && runtimeQueued.st.messageQueue[0]?.text === 'queued during work note');
  runtimeQueued.drainMessageQueue();
  ok('runtime-active WORK note cannot drain its queue early', runtimeBackend.prompts.length === 0
    && runtimeQueued.st.messageQueue.length === 1);
  runtimeBackend.runtimeBusy = false;
  runtimeQueued.drainMessageQueue();
  ok('runtime-idle boundary dispatches the queued WORK-note prompt', runtimeBackend.prompts[0] === 'queued during work note'
    && runtimeQueued.st.messageQueue.length === 0);

  c.setModel(c.st.modelOptions[1]);
  c.setEffort('high');
  ok('runtime switch records pending values without touching active task', c.st.model === 'a' && c.st.effort === 'low'
    && c.st.pendingModel?.id === 'b' && c.st.pendingEffort === 'high');

  backend.emit({ type: 'assistant_start' });
  backend.emit({ type: 'assistant_delta', delta: 'progress note' });
  backend.emit({ type: 'assistant_end', text: 'progress note', stopReason: 'toolUse' });
  await new Promise((resolve) => setImmediate(resolve));
  ok('toolUse assistant text never releases the next queued prompt', backend.prompts.length === 1 && c.st.messageQueue.length === 2);

  backend.emit({ type: 'assistant_start' });
  backend.emit({ type: 'assistant_delta', delta: 'final answer' });
  backend.emit({ type: 'assistant_end', text: 'final answer', stopReason: 'stop' });
  ok('final assistant waits for runtime settled before dequeue', backend.prompts.length === 1);
  backend.emit({ type: 'settled' });
  await new Promise((resolve) => setImmediate(resolve));
  ok('settled final applies runtime switches before dispatching FIFO head', backend.models.at(-1)?.id === 'b'
    && backend.efforts.at(-1) === 'high' && backend.prompts.join('|') === 'first request|second request'
    && c.st.messageQueue[0]?.text === 'third request');

  c.submitText('fourth request');
  c.submitText('fifth request');
  c.submitText('sixth request');
  setComposerInput(c.st, 'seventh request');
  c.submit();
  ok('queue accepts at most four and keeps an overflow draft', c.st.messageQueue.length === 4
    && c.st.input === 'seventh request');
  c.onKey({ name: 'backspace', alt: true });
  ok('alt-backspace removes the queue tail without editing composer', c.st.messageQueue.length === 3
    && !c.st.messageQueue.some((item) => item.text === 'sixth request') && c.st.input === 'seventh request');

  c.update(1 / 30, 0.3);
  c.render(0.3);
  ok('queue renders a distinct animated card with clickable deletes', c.s.ch.join('').includes('QUEUE')
    && c.st.queueHits.length === c.st.messageQueue.length);
  const click = c.st.queueHits[1];
  c.onKey({ name: 'mousedown', mouse: true, x: click.x1, y: click.y });
  ok('queue row delete target removes exactly the clicked prompt', c.st.messageQueue.length === 2
    && !c.st.messageQueue.some((item) => item.text === 'fourth request'));

  // ESC is a terminal turn outcome of its own and advances the queue after abort.
  c.interrupt();
  await new Promise((resolve) => setImmediate(resolve));
  ok('escape abort advances to the next queued prompt', backend.aborts === 1
    && backend.prompts.at(-1) === 'third request');

  c.backendUnsubscribe?.();
  c.clock.stop();
  runtimeQueued.backendUnsubscribe?.();
  runtimeQueued.clock.stop();
}

// ---- live backend bridge: normalized agent events ----
{
  class FakeBackend {
    constructor() {
      this.listeners = new Set(); this.prompts = []; this.aborts = 0; this.models = [];
      this.efforts = []; this.resets = 0; this.switched = [];
      this.news = 0;
    }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(event) { for (const fn of this.listeners) fn(event); }
    prompt(text) { this.prompts.push(text); return Promise.resolve(); }
    abort() { this.aborts++; return Promise.resolve(); }
    setModel(model) { this.models.push(model); return Promise.resolve(); }
    cycleModel() { this.emit({ type: 'model', model: { provider: 'test', id: 'model-b', label: 'model-b' } }); return Promise.resolve(); }
    setEffort(effort) { this.efforts.push(effort); this.emit({ type: 'effort', effort }); return effort; }
    cycleEffort() { this.emit({ type: 'effort', effort: 'high' }); return 'high'; }
    resetContext() { this.resets++; this.emit({ type: 'context_reset', sessionId: 'session-2' }); return Promise.resolve(); }
    newConversation() { this.news++; this.emit({ type: 'conversation_new', sessionId: 'session-new', sessionFile: 'NEW_SESSION' }); return Promise.resolve(); }
    listSessions() {
      return Promise.resolve([{ path: 'OLD_SESSION', title: 'Earlier conversation', modifiedLabel: '2h', messageCount: 4, current: false }]);
    }
    switchSession(path) {
      this.switched.push(path);
      this.emit({ type: 'ready', sessionId: 'old-session', sessionFile: path, model: { provider: 'test', id: 'model-a', label: 'model-a' } });
      this.emit({ type: 'history', messages: [{ role: 'user', text: 'old question' }, { role: 'approx', text: 'old answer' }] });
      return Promise.resolve();
    }
    dispose() {}
  }

  const backend = new FakeBackend();
  const c = new App({ noSplash: true, backend });
  c.s = new Screen(new FakeOut(80, 24));
  backend.emit({
    type: 'ready', runtime: 'Approx test', sessionId: 'session-1', effort: 'medium',
    effortOptions: ['low', 'medium', 'high'],
    model: { provider: 'test', id: 'model-a', label: 'model-a' },
    models: [
      { provider: 'test', id: 'model-a', label: 'model-a' },
      { provider: 'test', id: 'model-b', label: 'model-b' },
    ],
  });
  c.seed();

  ok('backend ready lands runtime state', c.st.runtime === 'Approx test' && c.st.model === 'model-a');
  c.st.input = '/model ';
  c.refreshSlash();
  ok('model slash opens model choices', c.st.slashMatches.length === 2 && c.st.slashMatches.every((it) => it.terminal));
  c.st.input = '/effort ';
  c.refreshSlash();
  ok('bare effort slash keeps Enter available for the level panel', c.st.slashMatches.length === 1
    && c.st.slashMatches[0].name === '/effort' && c.st.slashMatches[0].terminal);
  c.st.input = '/effort h';
  c.refreshSlash();
  ok('effort slash filters choices', c.st.slashMatches.length === 1 && c.st.slashMatches[0].name === '/effort high');
  c.st.input = '/effort-debug';
  c.refreshSlash();
  ok('effort debug is a directly-submittable slash command', c.cmds.some((cmd) => cmd.name === 'effort-debug')
    && c.st.slashMatches.length === 1 && c.st.slashMatches[0].terminal);
  const debugModel = c.st.model;
  const debugEffort = c.st.effort;
  const debugModels = backend.models.length;
  const debugEfforts = backend.efforts.length;
  const debugPromise = c.commandEffortDebug();
  const debugPicker = c.st.effortPicker;
  debugPicker.anim.set(1, true);
  c.onKey({ name: 'right' }); debugPicker.fade.set(1, true); c.render(0.1);
  const debugHigh = c.s.ch.join('');
  c.onKey({ name: 'right' }); debugPicker.fade.set(1, true); c.render(0.2);
  const debugXhigh = c.s.ch.join('');
  c.onKey({ name: 'right' }); debugPicker.fade.set(1, true); c.render(0.3);
  const debugMax = c.s.ch.join('');
  c.onKey({ name: 'enter' });
  const debugResult = await debugPromise;
  ok('effort debug previews fixed high/xhigh/max scenes without backend or runtime side effects',
    debugPicker.debug && debugPicker.previewOnly && debugPicker.options.join('|') === 'off|minimal|low|medium|high|xhigh|max'
    && debugHigh.includes('high') && debugXhigh.includes('xhigh') && debugMax.includes('max')
    && !debugResult.applied && c.st.model === debugModel && c.st.effort === debugEffort
    && backend.models.length === debugModels && backend.efforts.length === debugEfforts);
  c.st.input = '/markdown ';
  c.refreshSlash();
  ok('markdown slash offers on and off', c.st.slashMatches.map((it) => it.name).join('|') === '/markdown on|/markdown off');
  c.st.input = '';
  c.refreshSlash();
  c.submitText('hello Approx');
  ok('backend receives user prompt', backend.prompts[0] === 'hello Approx' && c.st.busy);

  backend.emit({ type: 'assistant_start' });
  for (const chunk of ['r', 'e', 'a', 'l', ' ', 's', 't', 'r', 'e', 'a', 'm']) {
    backend.emit({ type: 'assistant_delta', delta: chunk });
  }
  ok('fast deltas are coalesced until one frame', c.liveAssistant.text === '' && c._pendingLiveDelta === 'real stream');
  backend.emit({ type: 'assistant_end', text: 'real stream' });
  ok('backend deltas build one assistant message', c.st.msgs.filter((m) => m.role === 'approx').at(-1)?.text === 'real stream');

  backend.emit({ type: 'tool_start', id: 'call-1', name: 'read', title: 'Read renderer', meta: 'file.js' });
  backend.emit({ type: 'tool_update', id: 'call-1', text: 'partial' });
  backend.emit({ type: 'tool_end', id: 'call-1', text: 'done', isError: false });
  const tool = c.st.msgs.find((m) => m.callId === 'call-1');
  ok('backend tool lifecycle updates in place', tool?.text === 'done' && tool.running === false);
  ok('tool starts folded with title', tool?.expanded === false && tool?.title === 'Read renderer');
  const foldedHeight = totalHeight([tool], 60);
  c.toggleTool(tool);
  for (let i = 0; i < 40; i++) c.update(1 / 30, i / 30);
  ok('tool expands through animated height', tool.expanded && totalHeight([tool], 60) > foldedHeight);
  c.toggleFocusedTool();
  ok('ctrl-u target folds focused tool', tool.expanded === false);
  const heldMessages = c.st.msgs;
  c.st.msgs = [tool];
  c.st.scroll = 0;
  c.st.scrollTarget = 0;
  const toolVp = c.viewport();
  c.onKey({ name: 'mousedown', mouse: true, x: toolVp.x + 4, y: toolVp.y + 1 });
  ok('click expands folded tool', tool.expanded === true);
  c.st.msgs = heldMessages;

  backend.emit({ type: 'context', percent: 42 });
  ok('backend context drives meter target', Math.abs(c.st.ctxUse.target - 0.42) < 0.001);
  backend.emit({ type: 'settled' });
  await new Promise((resolve) => setImmediate(resolve));
  c.submitText('/skill:fixture test');
  ok('unknown slash command forwards to backend', backend.prompts.at(-1) === '/skill:fixture test');

  applySetting(c, 'model', 'model-b');
  applySetting(c, 'effort', 'high');
  ok('busy model and effort changes are visibly deferred', backend.models.length === 0 && backend.efforts.length === 0
    && c.st.pendingModel?.id === 'model-b' && c.st.pendingEffort === 'high');
  backend.emit({ type: 'assistant_end', text: 'extension complete', stopReason: 'stop' });
  backend.emit({ type: 'settled' });
  await new Promise((resolve) => setImmediate(resolve));
  ok('deferred model and effort apply after final delivery', backend.models.at(-1)?.id === 'model-b'
    && backend.efforts.at(-1) === 'high' && c.st.effort === 'high');
  c.commandMarkdown('off');
  ok('markdown command toggles renderer', c.st.markdown === false && c.st.msgs.every((msg) => msg.markdown === false));
  c.showHelp();
  ok('help is a guest-only message', c.st.msgs.at(-1)?.role === 'guest');

  ok('palette includes saved conversations', c.cmds.some((cmd) => cmd.name === 'history' && cmd.key === '^s'));
  c.openSessions();
  await Promise.resolve();
  ok('conversation picker loads auto-saved sessions', c.st.sessionPicker.open
    && c.st.sessionPicker.items[0]?.title === 'Earlier conversation');
  let sessionsThrew = false;
  try { c.update(1 / 30, 0.2); c.render(0.2); } catch { sessionsThrew = true; }
  ok('conversation picker renders', !sessionsThrew);
  c.onKey({ name: 'enter' });
  ok('returning to a conversation rehydrates transcript', backend.switched[0] === 'OLD_SESSION'
    && c.st.msgs.map((msg) => msg.text).join('|') === 'old question|old answer');

  backend.emit({ type: 'assistant_start' });
  backend.emit({ type: 'assistant_delta', delta: '真实流式 token 计数' });
  c.update(1 / 30, 0.25);
  ok('tps is driven by output deltas', c.st.tpsNow > 0);

  c.clearTranscript();
  ok('clear resets backend context', backend.resets === 1 && c.st.msgs.length === 0);

  c.push({ role: 'user', text: 'old branch', enter: 1 });
  c.newConversation();
  ok('new starts a separate conversation without reusing clear', backend.news === 1 && c.st.msgs.length === 0
    && c.st.sessionId === 'session-new');

  c.st.busy = true;
  c.interrupt();
  ok('interrupt reaches backend', backend.aborts === 1);

  c.backendUnsubscribe?.();
  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}
