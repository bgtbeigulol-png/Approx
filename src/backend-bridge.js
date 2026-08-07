import { Spring, clamp } from './anim.js';
import { invalidateLayoutTree } from './ui/transcript.js';
import { formatWorkingDirectory } from './directories.js';

/** Translate backend events into the app's live transcript state. */
export const backendBridgeMethods = {
  beginLiveStream() {
    if (this.liveAssistant) return this.liveAssistant;
    const m = this.push({ role: 'approx', text: '', streaming: true, streamChars: Infinity, _live: true });
    this.liveAssistant = m;
    this.st.busy = true;
    this.st.elapsed = 0;
    return m;
  },

  appendLiveDelta(delta) {
    const text = String(delta ?? '');
    if (!text) return;
    this.recordOutputTokens(text);
    this.beginLiveStream();
    this._pendingLiveDelta += text;
  },

  flushLiveDelta() {
    if (!this._pendingLiveDelta) return false;
    const m = this.beginLiveStream();
    m.text += this._pendingLiveDelta;
    this._pendingLiveDelta = '';
    m._lines = null;
    m._lw = -1;
    return true;
  },

  finishLiveStream(authoritativeText = null, meta = {}) {
    this.flushLiveDelta();
    const hasAuthoritativeText = authoritativeText != null;
    const finalText = String(authoritativeText ?? '');
    const m = this.liveAssistant;
    if (!m) {
      if (finalText) {
        const landed = this.push({ role: 'approx', text: finalText, stopReason: meta.stopReason });
        landed.enter = 0;
        this.st.turns++;
      }
      return;
    }
    if (hasAuthoritativeText && finalText !== m.text) {
      m.text = finalText;
      m._lines = null;
      m._lw = -1;
    }
    m.streaming = false;
    m.streamChars = Infinity;
    m.stopReason = meta.stopReason;
    this.liveAssistant = null;
    if (!m.text) {
      const i = this.st.msgs.indexOf(m);
      if (i >= 0) this.st.msgs.splice(i, 1);
    } else {
      this.st.turns++;
    }
    if (this.st.atBottom) this.scrollToBottom();
  },

  beginLiveTool(event) {
    const id = String(event.id ?? `tool-${Date.now()}`);
    this.flushLiveDelta();
    if (event.modelTitle) this.removeToolTitleFromLiveAssistant(event.title);
    if (event.modelGroupTitle) this.removeToolTitleFromLiveAssistant(event.groupHeading);
    const tool = this.push({
      role: 'tool',
      callId: id,
      name: String(event.name ?? 'tool'),
      title: String(event.title ?? event.name ?? 'tool'),
      fallbackTitle: String(event.fallbackTitle ?? event.name ?? 'tool'),
      modelTitle: !!event.modelTitle,
      groupTitle: event.groupTitle ? String(event.groupTitle) : '',
      modelGroupTitle: !!event.modelGroupTitle,
      meta: event.meta ? String(event.meta) : undefined,
      text: '',
      running: true,
      progress: null,
      expanded: false,
      expandAnim: new Spring(0, { stiff: 18, damp: 0.86 }),
    });
    this.liveTools.set(id, tool);
    const group = this.toolGroupFor(tool);
    this.st.toolFocus = group && !group.expanded ? group.callId : id;
    this.st.busy = true;
    this.scrollToBottom();
    return tool;
  },

  removeToolTitleFromLiveAssistant(title) {
    const msg = this.liveAssistant;
    if (!msg?.text || !title) return;
    const wanted = String(title).trim().toLowerCase();
    const lines = msg.text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      const match = /^\s*#{1,4}\s+(.+?)\s*$/.exec(lines[i]);
      if (!match || match[1].replace(/[*_`#]/g, '').trim().toLowerCase() !== wanted) break;
      lines.splice(i, 1);
      msg.text = lines.join('\n').replace(/\s+$/g, '');
      msg._lines = null;
      msg._lw = -1;
      break;
    }
  },

  updateLiveTool(event) {
    const tool = this.liveTools.get(String(event.id));
    if (!tool) return;
    tool.text = String(event.text ?? '');
    tool._lines = null;
    tool._lw = -1;
    invalidateLayoutTree(this.st.msgs);
  },

  finishLiveTool(event) {
    const id = String(event.id);
    const tool = this.liveTools.get(id);
    if (!tool) return;
    const text = String(event.text ?? '');
    if (text) tool.text = text;
    tool.running = false;
    tool.isError = !!event.isError;
    tool.progress = null;
    tool.meta = event.isError ? 'error' : (tool.meta || 'done');
    if (event.mutation) tool.mutation = event.mutation;
    tool._lines = null;
    tool._lw = -1;
    invalidateLayoutTree(this.st.msgs);
    this.liveTools.delete(id);
  },

  loadHistory(messages) {
    this.liveAssistant = null;
    this._pendingLiveDelta = '';
    this.liveTools.clear();
    this._activeTurn = null;
    this.st.messageQueue = [];
    this.st.queueGhosts = [];
    this.st.queueHits = [];
    this.st.queueAnim.set(0, true);
    this.st.msgs = [];
    this.st.toolFocus = null;
    this.st.atBottom = false;
    for (const source of messages ?? []) {
      const msg = { enter: 1, ...source };
      if (msg.role === 'tool') {
        msg.expanded = !!msg.expanded;
        msg.expandAnim = new Spring(msg.expanded ? 1 : 0, { stiff: 18, damp: 0.86 });
      }
      if (msg.role === 'toolgroup') {
        msg.expanded = !!msg.expanded;
        msg.expandAnim = new Spring(msg.expanded ? 1 : 0, { stiff: 18, damp: 0.86 });
        for (const tool of msg.tools ?? []) {
          tool.expanded = !!tool.expanded;
          tool.expandAnim = new Spring(tool.expanded ? 1 : 0, { stiff: 18, damp: 0.86 });
        }
      }
      if (msg.role === 'workgroup') {
        msg.expanded = !!msg.expanded;
        msg.expandAnim = new Spring(msg.expanded ? 1 : 0, { stiff: 18, damp: 0.86 });
        for (const group of msg.tools ?? []) {
          group.expanded = !!group.expanded;
          group.expandAnim = new Spring(group.expanded ? 1 : 0, { stiff: 18, damp: 0.86 });
          for (const tool of group.tools ?? []) {
            tool.expanded = !!tool.expanded;
            tool.expandAnim = new Spring(tool.expanded ? 1 : 0, { stiff: 18, damp: 0.86 });
          }
        }
      }
      this.push(msg);
    }
    this.archiveCompletedWork();
    this.st.history = this.st.msgs.filter((msg) => msg.role === 'user').map((msg) => msg.text);
    this.st.histIdx = -1;
    this.st.turns = this.st.history.length;
    this.st.scrollTarget = this.maxScroll();
    this.st.scrollSpring.set(this.st.scrollTarget, true);
    this.st.scroll = this.st.scrollTarget;
    this.st.atBottom = true;
    this.st.busy = false;
    this.s.invalidate();
  },

  onBackendEvent(event) {
    if (!event || !this.alive) return;
    switch (event.type) {
      case 'ready':
        this.st.runtime = event.runtime || 'Approx';
        this.st.sessionId = event.sessionId || '';
        this.st.effort = event.effort || '';
        this.st.effortOptions = (event.effortOptions || []).map(String);
        this.st.modelOptions = (event.models || []).filter(Boolean);
        if (event.model) this.st.model = event.model.label;
        this.st.sessionFile = event.sessionFile || '';
        if (event.cwd) {
          this.st.cwdPath = event.cwd;
          this.st.cwd = formatWorkingDirectory(event.cwd);
        }
        if (Number.isFinite(event.model?.contextWindow)) this.st.contextWindow = event.model.contextWindow;
        if (event.plan) this.applyPlanState(event.plan, { pulse: false });
        this.restoreRuntimePreferences();
        this.persistPreferences();
        break;
      case 'history': this.loadHistory(event.messages); break;
      case 'plan_update':
        if (event.plan) this.applyPlanState(event.plan);
        break;
      case 'questionnaire':
        if (event.request) void this.openQuestionnaire(event.request);
        break;
      case 'workspace_changed': {
        this.resetTranscriptView();
        this.st.cwdPath = String(event.cwd || this.st.cwdPath || process.cwd());
        this.st.cwd = formatWorkingDirectory(this.st.cwdPath);
        this.st.sessionId = event.sessionId || '';
        this.st.sessionFile = event.sessionFile || '';
        this.st.directoryPicker.path = this.st.cwdPath;
        this.st.directoryPicker.pathInput = this.st.cwdPath;
        if (event.plan) this.applyPlanState(event.plan, { pulse: false });
        this.st.turns = 0;
        this.st.history = [];
        this.st.histIdx = -1;
        this.st.busy = false;
        this.seed();
        this.toast('workspace switched', 'ok');
        break;
      }
      case 'busy': this.st.busy = true; this.st.elapsed = 0; break;
      case 'assistant_start': this.beginLiveStream(); break;
      case 'assistant_delta': this.appendLiveDelta(event.delta); break;
      case 'assistant_end':
        this.finishLiveStream(event.text, event);
        this.noteAssistantDelivery(event.stopReason);
        break;
      case 'tool_start': this.beginLiveTool(event); break;
      case 'tool_update': this.updateLiveTool(event); break;
      case 'tool_end': this.finishLiveTool(event); break;
      case 'user_entry': {
        const pending = this.st.msgs.find((msg) => msg.role === 'user' && msg._awaitEntry
          && msg.text === String(event.text ?? ''));
        if (pending) {
          pending.entryId = String(event.entryId);
          pending._awaitEntry = false;
        }
        break;
      }
      case 'context':
        this.st.ctxTokens = Number.isFinite(event.tokens) ? event.tokens : null;
        if (Number.isFinite(event.contextWindow)) this.st.contextWindow = event.contextWindow;
        if (Number.isFinite(event.percent)) this.st.ctxUse.set(clamp(event.percent / 100, 0, 1));
        break;
      case 'compaction_start': {
        const compact = ensureCompactState(this.st);
        compact.seq++;
        compact.active = true;
        compact.phase = 'running';
        compact.reason = String(event.reason || 'manual');
        compact.startedAt = this.clock?.t ?? 0;
        compact.finishedAt = 0;
        compact.tokensBefore = Number.isFinite(this.st.ctxTokens) ? this.st.ctxTokens : null;
        compact.tokensAfter = null;
        compact.error = '';
        compact.enter.set(1, this.st.reduceMotion);
        compact.progress.set(0, true);
        compact.pulse.set(1, true);
        compact.pulse.set(0);
        this.st.busy = true;
        this.s.invalidate();
        break;
      }
      case 'compaction_end': {
        const compact = ensureCompactState(this.st);
        const seq = compact.seq;
        compact.active = false;
        compact.finishedAt = this.clock?.t ?? compact.startedAt;
        compact.tokensBefore = Number.isFinite(event.tokensBefore) ? event.tokensBefore : compact.tokensBefore;
        compact.tokensAfter = Number.isFinite(event.estimatedTokensAfter) ? event.estimatedTokensAfter : null;
        compact.error = String(event.errorMessage || '');
        compact.phase = compact.error ? 'error' : event.aborted ? 'aborted' : 'done';
        compact.progress.set(compact.phase === 'done' ? 1 : 0, this.st.reduceMotion);
        compact.pulse.set(1, true);
        compact.pulse.set(0);
        if (Number.isFinite(compact.tokensAfter) && Number.isFinite(this.st.contextWindow) && this.st.contextWindow > 0) {
          this.st.ctxTokens = compact.tokensAfter;
          this.st.ctxUse.set(clamp(compact.tokensAfter / this.st.contextWindow, 0, 1));
        }
        const message = compact.error
          || (compact.phase === 'aborted' ? 'context compaction interrupted' : 'context compacted');
        this.toast(message, compact.error || compact.phase === 'aborted' ? 'warn' : 'ok');
        if (!this._activeTurn) {
          this.st.busy = false;
          void this.applyPendingRuntimeChanges()
            .catch((error) => this.toast(String(error?.message ?? error), 'warn'))
            .finally(() => this.drainMessageQueue());
        }
        this.later(() => {
          if (compact.seq === seq && compact.phase !== 'running') compact.enter.set(0, this.st.reduceMotion);
        }, compact.phase === 'done' ? 1050 : 1500);
        this.s.invalidate();
        break;
      }
      case 'usage': {
        const tokens = Number(event.outputTokens);
        if (Number.isFinite(tokens) && tokens >= 0 && this.st.elapsed > 0) {
          this.st.tpsNow = tokens / this.st.elapsed;
          this.st.tps.shift();
          this.st.tps.push(this.st.tpsNow);
        }
        break;
      }
      case 'model':
        if (event.model) this.st.model = event.model.label;
        if (event.effort) this.st.effort = event.effort;
        if (event.effortOptions) this.st.effortOptions = event.effortOptions.map(String);
        this.s.invalidate();
        this.persistPreferences();
        break;
      case 'effort':
        this.st.effort = event.effort || '';
        this.toast(`effort ${this.st.effort}`, 'ok');
        this.persistPreferences();
        break;
      case 'context_reset':
        this.st.sessionId = event.sessionId || this.st.sessionId;
        this.st.ctxTokens = 0;
        this.st.ctxUse.set(0, true);
        this.st.busy = false;
        this.toast('context cleared', 'ok');
        void this.applyPendingRuntimeChanges().finally(() => this.drainMessageQueue());
        break;
      case 'conversation_new':
        this.st.sessionId = event.sessionId || this.st.sessionId;
        this.st.sessionFile = event.sessionFile || this.st.sessionFile;
        this.st.ctxTokens = 0;
        this.st.ctxUse.set(0, true);
        this.st.busy = false;
        this.toast('new conversation ready', 'ok');
        break;
      case 'status': this.toast(event.text, event.kind || 'info'); break;
      case 'error':
        this.finishLiveStream();
        if (this._activeTurn) this._activeTurn.failed = true;
        this.push({ role: 'system', text: `Approx error: ${event.error}` });
        this.toast('Approx request failed', 'warn');
        this.scrollToBottom();
        break;
      case 'settled':
        for (const tool of this.liveTools.values()) tool.running = false;
        this.liveTools.clear();
        // A runtime can report an idle phase before the request promise resolves.
        // Let the turn state machine decide when the whole request has ended, so
        // later notes and tools stay within the same WORK envelope.
        const hadActiveTurn = !!this._activeTurn;
        this.noteRuntimeSettled();
        // History/test feeds may deliver a settled marker without an active turn.
        // Those entries are complete already and still need their archived view.
        if (!hadActiveTurn) this.archiveCompletedWork();
        break;
      default: break;
    }
  },
};

function ensureCompactState(st) {
  if (st.compact) return st.compact;
  st.compact = {
    seq: 0,
    active: false,
    phase: 'idle',
    reason: 'manual',
    startedAt: 0,
    finishedAt: 0,
    tokensBefore: null,
    tokensAfter: null,
    error: '',
    enter: new Spring(0, { stiff: 20, damp: 0.82 }),
    progress: new Spring(0, { stiff: 12, damp: 0.9 }),
    pulse: new Spring(0, { stiff: 18, damp: 0.72 }),
  };
  return st.compact;
}
