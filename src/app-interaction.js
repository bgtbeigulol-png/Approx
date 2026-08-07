import { Spring, clamp } from './anim.js';
import { copyToClipboard } from './ansi.js';
import { selectionRanges } from './app-geometry.js';
import { setComposerInput } from './composer-state.js';
import { T, mix } from './theme.js';
import { composerHeight } from './ui/composer.js';
import { HEADER_H } from './ui/header.js';
import { planHeight } from './ui/plan.js';
import { queueHeight } from './ui/queue.js';
import { tickAtRow, RAIL_W } from './ui/rail.js';
import { STATUS_H } from './ui/status.js';
import { totalHeight, msgHeight, visibleLines } from './ui/transcript.js';

/** Viewport, selection, rewind/redo, tool folding, and navigation-rail interaction. */
export const interactionMethods = {
  bodyWidth() {
    return Math.max(24, this.s.w - RAIL_W - 3);
  },

  viewport() {
    const composerH = composerHeight(this.st.input, this.s.w - 2);
    const queuedH = queueHeight(this.st);
    const planH = planHeight(this.st, Math.max(3, Math.floor(this.s.h * 0.42)));
    const top = HEADER_H + 1;
    const bottom = this.s.h - STATUS_H - composerH - queuedH - (queuedH ? 1 : 0)
      - planH - (planH ? 1 : 0) - 2;
    return {
      x: RAIL_W + 1,
      y: top,
      w: this.bodyWidth(),
      h: Math.max(1, bottom - top + 1),
      composerH,
      queuedH,
      planH,
    };
  },

  docHeight() {
    return totalHeight(this.st.msgs, this.bodyWidth());
  },

  maxScroll() {
    const { h } = this.viewport();
    return Math.max(0, this.docHeight() - h);
  },

  clampScroll() {
    const max = this.maxScroll();
    this.st.scrollTarget = clamp(this.st.scrollTarget, 0, max);
    this.st.scrollSpring.set(this.st.scrollTarget, this.st.reduceMotion);
  },

  scrollBy(amount) {
    this.st.scrollTarget = clamp(this.st.scrollTarget + amount, 0, this.maxScroll());
    this.st.scrollSpring.set(this.st.scrollTarget, this.st.reduceMotion);
    this.st.atBottom = this.st.scrollTarget >= this.maxScroll() - 0.5;
  },

  scrollTo(position) {
    this.st.scrollTarget = clamp(position, 0, this.maxScroll());
    this.st.scrollSpring.set(this.st.scrollTarget, this.st.reduceMotion);
    this.st.atBottom = this.st.scrollTarget >= this.maxScroll() - 0.5;
  },

  scrollToBottom() {
    this.st.atBottom = true;
    this.st.scrollTarget = this.maxScroll();
    this.st.scrollSpring.set(this.st.scrollTarget, this.st.reduceMotion);
  },

  messageAt(x, y) {
    const viewport = this.viewport();
    if (x < viewport.x || x >= viewport.x + viewport.w
      || y < viewport.y || y >= viewport.y + viewport.h) return null;
    const row = Math.round(this.st.scroll) + (y - viewport.y);
    const width = this.bodyWidth();
    let top = 0;
    for (let index = 0; index < this.st.msgs.length; index++) {
      const message = this.st.msgs[index];
      const height = msgHeight(message, width);
      if (row >= top && row < top + height) {
        const offset = row - top;
        const line = offset > 0 ? visibleLines(message, width)[offset - 1] ?? null : null;
        return { msg: message, index, top, h: height, offset, line };
      }
      top += height;
    }
    return null;
  },

  beginPointer(x, y, hit = null) {
    const viewport = this.viewport();
    if (x < viewport.x || x >= viewport.x + viewport.w
      || y < viewport.y || y >= viewport.y + viewport.h) {
      this.st.pointerDown = null;
      this.st.textSelection = null;
      return;
    }
    const point = {
      x: clamp(x, viewport.x, viewport.x + viewport.w - 1),
      y: clamp(y, viewport.y, viewport.y + viewport.h - 1),
    };
    this.st.pointerDown = { ...point, moved: false, hit };
    this.st.textSelection = { anchor: point, focus: point, active: true };
  },

  dragTextSelection(x, y) {
    const down = this.st.pointerDown;
    if (!down) return;
    const viewport = this.viewport();
    const focus = {
      x: clamp(x, viewport.x, viewport.x + viewport.w - 1),
      y: clamp(y, viewport.y, viewport.y + viewport.h - 1),
    };
    down.moved ||= focus.x !== down.x || focus.y !== down.y;
    this.st.textSelection = {
      anchor: { x: down.x, y: down.y },
      focus,
      active: true,
    };
    this.railHoverAt(viewport.x + 1, focus.y);
  },

  finishPointer(x, y) {
    const down = this.st.pointerDown;
    if (!down) return;
    if (down.moved) {
      this.dragTextSelection(x, y);
      const text = this.selectedScreenText();
      if (copyToClipboard(text, this.s.out)) this.toast(`copied ${[...text].length} characters`, 'ok');
      this.st.textSelection.active = false;
    } else {
      this.st.textSelection = null;
    }
    this.st.pointerDown = null;
  },

  selectedScreenText() {
    const selection = this.st.textSelection;
    if (!selection) return '';
    const viewport = this.viewport();
    const ranges = selectionRanges(selection, viewport);
    const lines = [];
    const grainFg = mix(T.bg, T.sand, 0.11);
    for (const range of ranges) {
      let line = '';
      const first = range.y * this.s.w + range.x1;
      if (this.s.ch[first] === '' && range.x1 > viewport.x) line += this.s.ch[first - 1] || '';
      for (let x = range.x1; x <= range.x2; x++) {
        const index = range.y * this.s.w + x;
        const character = this.s.ch[index];
        if (character === '·' && this.s.fg[index] === grainFg && this.s.bg[index] === T.bg) line += ' ';
        else if (character) line += character;
      }
      lines.push(line.replace(/\s+$/u, ''));
    }
    return lines.join('\n').replace(/^\s+|\s+$/gu, '');
  },

  pressUserMessage(message) {
    if ((this.st.messageEdit.mode === 'editing' || this.st.messageEdit.mode === 'confirm')
      && this.st.messageEdit.target !== message) this.cancelMessageEdit();
    const now = performance.now();
    const last = this.st.lastUserClick;
    const doubled = last?.msg === message && now - last.at <= 430;
    this.st.lastUserClick = { msg: message, at: now };
    if (doubled) return this.beginMessageEdit(message);
    this.selectUserMessage(message);
  },

  selectUserMessage(message) {
    if (!message || message.role !== 'user') return;
    const edit = this.st.messageEdit;
    if (edit.target && edit.target !== message) edit.target._selectAnim?.set(0, this.st.reduceMotion);
    message._selectAnim ??= new Spring(0, { stiff: 24, damp: 0.88 });
    message._selectAnim.set(1, this.st.reduceMotion);
    edit.target = message;
    edit.mode = 'selected';
    this.st.textSelection = null;
  },

  keyboardEditMessage() {
    const edit = this.st.messageEdit;
    if (edit.mode === 'editing') return this.prepareMessageRewind(this.st.input.trim());
    if (edit.mode === 'selected' && edit.target) return this.beginMessageEdit(edit.target);
    const latest = [...this.st.msgs].reverse().find((message) => message.role === 'user');
    if (!latest) return this.toast('no user message to edit', 'warn');
    this.selectUserMessage(latest);
    this.toast('user message selected · ^e or enter to edit', 'info');
  },

  cycleSelectedUser(direction) {
    const users = this.st.msgs.filter((message) => message.role === 'user');
    if (!users.length) return;
    const current = users.indexOf(this.st.messageEdit.target);
    const next = current < 0 ? users.length - 1 : clamp(current + direction, 0, users.length - 1);
    this.selectUserMessage(users[next]);
    this.jumpToMessage(this.st.msgs.indexOf(users[next]));
  },

  beginMessageEdit(message) {
    if (!message || message.role !== 'user') return;
    if (this.st.busy) this.interrupt();
    const edit = this.st.messageEdit;
    if (edit.mode !== 'editing') edit.originalComposer = this.st.input;
    edit.target = message;
    edit.draft = message.text;
    edit.mode = 'editing';
    message._selectAnim ??= new Spring(1, { stiff: 24, damp: 0.88 });
    message._selectAnim.set(1, this.st.reduceMotion);
    setComposerInput(this.st, message.text);
    this.st.slashMatches = [];
    this.st.slashAnim.set(0);
    this.st.focusAnim.set(1);
    this.toast('editing user message · enter to retry', 'info');
  },

  cancelMessageEdit(restoreComposer = true) {
    const edit = this.st.messageEdit;
    edit.target?._selectAnim?.set(0, this.st.reduceMotion);
    if (restoreComposer && (edit.mode === 'editing' || edit.mode === 'confirm')) {
      setComposerInput(this.st, edit.originalComposer);
    }
    edit.mode = 'idle';
    edit.target = null;
    edit.draft = '';
    edit.messageCount = 0;
    edit.mutationCount = 0;
    edit.mutations = [];
    edit.mutationCallIds = [];
    this.st.rewindAnim.set(0, this.st.reduceMotion);
    this.st.lastUserClick = null;
  },

  prepareMessageRewind(raw) {
    const edit = this.st.messageEdit;
    const targetIndex = this.st.msgs.indexOf(edit.target);
    if (!raw || targetIndex < 0) return;
    const suffix = this.st.msgs.slice(targetIndex);
    const mutations = collectMutations(suffix);
    const mutationCallIds = collectMutationCallIds(suffix);
    edit.draft = raw;
    edit.messageCount = suffix.length;
    edit.mutationCount = new Set([
      ...mutations.map((mutation) => mutation.callId).filter(Boolean),
      ...mutationCallIds,
    ]).size || mutations.length;
    edit.mutations = mutations;
    edit.mutationCallIds = mutationCallIds;
    edit.mode = 'confirm';
    this.st.rewindAnim.set(1, this.st.reduceMotion);
  },

  rewindConfirmKey(key) {
    const yes = key.name === 'enter'
      || (!key.ctrl && !key.alt && String(key.name).toLowerCase() === 'y');
    const no = key.name === 'escape'
      || (!key.ctrl && !key.alt && String(key.name).toLowerCase() === 'n');
    if (yes) return void this.commitMessageRewind();
    if (no) {
      this.st.messageEdit.mode = 'editing';
      this.st.rewindAnim.set(0, this.st.reduceMotion);
      this.toast('rewind cancelled · draft kept', 'info');
    }
  },

  async commitMessageRewind() {
    const edit = this.st.messageEdit;
    if (edit.mode !== 'confirm') return;
    const target = edit.target;
    const targetIndex = this.st.msgs.indexOf(target);
    if (targetIndex < 0) return this.cancelMessageEdit();
    const prefix = this.st.msgs.slice(0, targetIndex);
    const removedMsgs = this.st.msgs.slice(targetIndex);
    const mutations = [...edit.mutations];
    const mutationCallIds = [...edit.mutationCallIds];
    const draft = edit.draft;
    const originalComposer = edit.originalComposer;
    edit.mode = 'applying';
    this.st.busy = true;
    this.st.rewindAnim.set(0, this.st.reduceMotion);
    if (!this.st.reduceMotion) {
      this.st.wipeDir = -1;
      this.st.wipe = 0.001;
    }

    try {
      let token = null;
      if (this.backend?.rewindContext) {
        const userIndex = this.st.msgs.slice(0, targetIndex + 1)
          .filter((message) => message.role === 'user').length - 1;
        const entryId = target.entryId
          || this.backend.resolveUserEntryAt?.(userIndex, target.text)
          || this.backend.resolveUserEntry?.(target.text);
        token = await this.backend.rewindContext(entryId, mutations, mutationCallIds);
      }
      const rewoundMutations = token?.mutations ?? mutations;

      target._selectAnim?.set(0, true);
      this.liveAssistant = null;
      this.liveTools.clear();
      this.st.msgs = [...prefix];
      const replacement = this.push({
        role: 'user',
        text: draft,
        enter: 0,
        _awaitEntry: !!this.backend,
        rewound: true,
        redoAvailable: true,
      });
      this.st.redo = { prefix, removedMsgs, mutations: rewoundMutations, token, replacement, used: false };
      edit.mode = 'idle';
      edit.target = null;
      edit.draft = '';
      edit.mutations = [];
      edit.mutationCallIds = [];
      setComposerInput(this.st, originalComposer);
      this.st.history.push(draft);
      this.st.histIdx = -1;
      this.scrollToBottom();
      this._activeTurn = null;
      this.dispatchTurn(draft, { push: false, userMessage: replacement, source: 'retry' });
      this.toast(`rewound ${removedMsgs.length} messages · ${rewoundMutations.length} file changes undone`, 'ok');
    } catch (error) {
      edit.mode = 'editing';
      setComposerInput(this.st, draft);
      this.st.busy = false;
      this.toast(String(error?.message ?? error), 'warn');
    }
  },

  async performRedo() {
    const redo = this.st.redo;
    if (!redo || redo.used) return this.toast('nothing to redo', 'warn');
    redo.used = true;
    redo.replacement.redoAvailable = false;
    const wasBusy = this.st.busy;
    this.st.busy = true;
    try {
      if (wasBusy && this.backend?.abort) await this.backend.abort();
      const retryIndex = this.st.msgs.indexOf(redo.replacement);
      const abandonedMutations = collectMutations(retryIndex >= 0 ? this.st.msgs.slice(retryIndex) : []);
      if (this.backend?.redoRewind && redo.token) {
        await this.backend.redoRewind(redo.token, redo.mutations, abandonedMutations);
      }
      this.liveAssistant = null;
      this.liveTools.clear();
      for (const message of redo.removedMsgs) message._selectAnim?.set(0, true);
      this.st.msgs = [...redo.prefix, ...redo.removedMsgs];
      this.st.redo = null;
      this.st.busy = false;
      this.st.wipeDir = 1;
      if (!this.st.reduceMotion) this.st.wipe = 0.001;
      this.scrollToBottom();
      this.toast(`restored ${redo.removedMsgs.length} messages · ${redo.mutations.length} file changes`, 'ok');
    } catch (error) {
      redo.used = false;
      redo.replacement.redoAvailable = true;
      this.st.busy = false;
      this.toast(String(error?.message ?? error), 'warn');
    }
  },

  toggleTool(tool) {
    if (!tool || tool.role !== 'tool') return;
    tool.expanded = !tool.expanded;
    tool.expandAnim ??= new Spring(tool.expanded ? 1 : 0, { stiff: 18, damp: 0.86 });
    tool.expandAnim.set(tool.expanded ? 1 : 0, this.st.reduceMotion);
    const group = this.toolGroupFor(tool);
    this.st.toolFocus = !tool.expanded && group ? group.callId : (tool.callId ?? tool);
    this.toast(`${tool.title ?? tool.name} ${tool.expanded ? 'expanded' : 'folded'}`, 'info');
    if (this.st.atBottom) this.scrollToBottom();
  },

  toggleToolGroup(group) {
    if (!group || group.role !== 'toolgroup') return;
    group.expanded = !group.expanded;
    group.expandAnim ??= new Spring(group.expanded ? 1 : 0, { stiff: 18, damp: 0.86 });
    group.expandAnim.set(group.expanded ? 1 : 0, this.st.reduceMotion);
    const latest = group.tools?.at(-1);
    this.st.toolFocus = group.expanded && latest ? (latest.callId ?? latest) : group.callId;
    this.toast(`${group.title} ${group.expanded ? 'expanded' : 'folded'}`, 'info');
    if (this.st.atBottom) this.scrollToBottom();
  },

  toggleWorkGroup(group) {
    if (!group || group.role !== 'workgroup') return;
    group.expanded = !group.expanded;
    group.expandAnim ??= new Spring(group.expanded ? 1 : 0, { stiff: 18, damp: 0.86 });
    group.expandAnim.set(group.expanded ? 1 : 0, this.st.reduceMotion);
    this.st.toolFocus = group.expanded
      ? (group.tools?.[0]?.callId ?? group.tools?.[0] ?? group)
      : group;
    this.toast(`${group.title || 'Work'} ${group.expanded ? 'expanded' : 'folded'}`, 'info');
    if (this.st.atBottom) this.scrollToBottom();
  },

  toggleFocusedTool() {
    let tool = null;
    let group = null;
    let workgroup = null;
    if (this.st.toolFocus != null) {
      ({ tool, group, workgroup } = findFocusedTool(this.st.msgs, this.st.toolFocus));
      if (!tool && !group) {
        workgroup = this.st.msgs.find((message) => message.role === 'workgroup'
          && (message === this.st.toolFocus || message.callId === this.st.toolFocus));
      }
    }
    if (!tool && !group) {
      const viewport = this.viewport();
      const viewTop = Math.round(this.st.scroll);
      const viewBottom = viewTop + viewport.h;
      let docY = 0;
      for (const message of this.st.msgs) {
        const height = msgHeight(message, this.bodyWidth());
        if ((message.role === 'tool' || message.role === 'toolgroup' || message.role === 'workgroup')
          && docY < viewBottom && docY + height > viewTop) {
          if (message.role === 'workgroup') workgroup = message;
          else if (message.role === 'toolgroup') group = message;
          else tool = message;
        }
        docY += height;
      }
    }
    if (!tool && !group) {
      const target = [...this.st.msgs].reverse()
        .find((message) => message.role === 'tool' || message.role === 'toolgroup' || message.role === 'workgroup');
      if (target?.role === 'workgroup') workgroup = target;
      else if (target?.role === 'toolgroup') group = target;
      else tool = target;
    }
    if (workgroup && !workgroup.expanded) return this.toggleWorkGroup(workgroup);
    if (workgroup && !tool && !group) return this.toggleWorkGroup(workgroup);
    if (!tool && !group) return this.toast('no tool call to expand', 'warn');
    if (group && !group.expanded) return this.toggleToolGroup(group);
    if (group && !tool) return this.toggleToolGroup(group);
    this.toggleTool(tool);
  },

  railTickAt(x, y) {
    const viewport = this.viewport();
    if (x > RAIL_W || y < viewport.y || y >= viewport.y + viewport.h) return null;
    return tickAtRow(this.st.railTicks, y - viewport.y);
  },

  railHoverAt(x, y) {
    const state = this.st;
    const tick = this.railTickAt(x, y);
    if (!tick) {
      if (state.railHover >= 0) {
        state.railHover = -1;
        state.railAmt.set(0);
      }
      return;
    }
    const switched = tick.index !== state.railHover;
    state.railHover = tick.index;
    state.railBulge.set(tick.row, switched || state.reduceMotion);
    state.railAmt.set(1);
  },

  railHoverTick() {
    if (this.st.railHover < 0) return null;
    return this.st.railTicks.find((tick) => tick.index === this.st.railHover) ?? null;
  },

  jumpToMessage(index) {
    this.jumpToMessageRow(index, 0);
  },

  jumpToMessageRow(index, rowOffset = 0) {
    const messages = this.st.msgs;
    if (index < 0 || index >= messages.length) return;
    const width = this.bodyWidth();
    let docY = 0;
    for (let current = 0; current < index; current++) docY += msgHeight(messages[current], width);

    const from = this.st.scrollTarget;
    const to = clamp(docY + (Number(rowOffset) || 0), 0, this.maxScroll());
    this.st.scrollTarget = to;
    this.st.scrollSpring.set(to, true);
    this.st.scroll = to;
    this.st.atBottom = to >= this.maxScroll() - 0.5;

    if (!this.st.reduceMotion) {
      this.st.wipeDir = to >= from ? 1 : -1;
      this.st.wipe = 0.0001;
    }
  },
};

function findFocusedTool(messages, focus) {
  for (const message of messages) {
    if (message.role === 'tool' && (message === focus || message.callId === focus)) {
      return { tool: message, group: null, workgroup: null };
    }
    if (message.role === 'toolgroup') {
      if (message === focus || message.callId === focus) return { tool: null, group: message, workgroup: null };
      const tool = message.tools?.find((item) => item === focus || item.callId === focus);
      if (tool) return { tool, group: message, workgroup: null };
    }
    if (message.role === 'workgroup') {
      if (message === focus || message.callId === focus) return { tool: null, group: null, workgroup: message };
      for (const group of message.tools ?? []) {
        if (group === focus || group.callId === focus) return { tool: null, group, workgroup: message };
        const tool = group.tools?.find((item) => item === focus || item.callId === focus);
        if (tool) return { tool, group, workgroup: message };
      }
    }
  }
  return { tool: null, group: null, workgroup: null };
}

function collectMutations(messages) {
  const mutations = [];
  for (const message of messages) {
    if (message.role === 'tool' && message.mutation) mutations.push(message.mutation);
    if (message.role === 'toolgroup') {
      for (const tool of message.tools ?? []) if (tool.mutation) mutations.push(tool.mutation);
    }
    if (message.role === 'workgroup') {
      for (const group of message.tools ?? []) {
        for (const tool of group.tools ?? []) if (tool.mutation) mutations.push(tool.mutation);
      }
    }
  }
  return mutations;
}

function collectMutationCallIds(messages) {
  const ids = [];
  const take = (tool) => {
    const name = String(tool?.name ?? '').toLowerCase();
    if ((name === 'write' || name === 'edit') && tool.callId) ids.push(String(tool.callId));
  };
  for (const message of messages) {
    if (message.role === 'tool') take(message);
    if (message.role === 'toolgroup') for (const tool of message.tools ?? []) take(tool);
    if (message.role === 'workgroup') {
      for (const group of message.tools ?? []) for (const tool of group.tools ?? []) take(tool);
    }
  }
  return ids;
}
