import { Spring, clamp } from './anim.js';
import { RESET, sgr } from './ansi.js';
import { totalChars } from './app-geometry.js';
import { Screen } from './screen.js';
import { buildFileChanges, summarizeFileChanges } from './file-changes.js';
import { invalidateLayoutTree } from './ui/transcript.js';

/** Transcript mutation, WORK archival, streaming, snapshots, and resets. */
export const transcriptMethods = {
  push(message) {
    const landed = {
      role: 'approx',
      text: '',
      time: stamp(),
      enter: 0,
      ...message,
    };
    if (landed.markdown == null) {
      landed.markdown = landed.role !== 'user' && landed.role !== 'tool'
        && landed.role !== 'toolgroup' && landed.role !== 'workgroup'
        && landed.subtype !== 'changeset' && this.st.markdown;
    }
    if (landed.role === 'tool') this.landTool(landed);
    else this.st.msgs.push(landed);
    if (this.st.jump) this.refreshJump();
    if (this.st.atBottom) this.scrollToBottom();
    return landed;
  },

  landTool(tool) {
    const messages = this.st.msgs;
    const last = messages.at(-1);
    const explicitBoundary = last?.role === 'toolgroup' && tool.groupTitle && last.modelTitle
      && normalizeTitle(tool.groupTitle) !== normalizeTitle(last.title);
    if (last?.role === 'toolgroup' && !explicitBoundary) {
      last.tools.push(tool);
      if (tool.groupTitle) {
        last.title = tool.groupTitle;
        last.modelTitle = !!tool.modelGroupTitle;
      } else if (!last.modelTitle) {
        last.title = fallbackToolGroupTitle(last.tools);
      }
      invalidateLayoutTree(messages);
      return tool;
    }

    const previous = messages.at(-1);
    const before = messages.at(-2);
    if (previous?.role === 'tool' && before?.role === 'tool') {
      messages.splice(-2, 2);
      const tools = [before, previous, tool];
      const named = tools.find((item) => item.groupTitle);
      const promoted = !named ? tools.find((item) => item.modelTitle && item.title)?.title : '';
      if (promoted) {
        const source = tools.find((item) => item.modelTitle && item.title === promoted);
        source.title = source.fallbackTitle || source.name || 'tool';
        source.modelTitle = false;
      }
      messages.push({
        role: 'toolgroup',
        callId: `tool-group-${++this._toolGroupSeq}`,
        title: named?.groupTitle || promoted || fallbackToolGroupTitle(tools),
        modelTitle: !!named?.modelGroupTitle || !!promoted,
        tools,
        text: '',
        time: before.time,
        enter: 0,
        expanded: false,
        expandAnim: new Spring(0, { stiff: 18, damp: 0.86 }),
        markdown: false,
      });
    } else {
      messages.push(tool);
    }
    return tool;
  },

  archiveCompletedWork() {
    let changed = false;
    let again = true;
    while (again) {
      again = false;
      const messages = this.st.msgs;
      for (let userIndex = 0; userIndex < messages.length; userIndex++) {
        if (messages[userIndex]?.role !== 'user') continue;
        let end = userIndex + 1;
        while (end < messages.length && messages[end]?.role !== 'user') end++;
        const segment = messages.slice(userIndex + 1, end);
        const existingWork = segment.find((message) => message.role === 'workgroup') ?? null;

        const finalLocal = findFinalApprox(segment);
        if (finalLocal < 0) continue;
        const lastToolLocal = segment.reduce((lastIndex, message, index) => (
          isArchivableTool(message) ? index : lastIndex
        ), -1);
        if (lastToolLocal < 0) continue;
        const hasRawWorkAfterArchive = existingWork
          && segment.some((message, index) => index < finalLocal && message !== existingWork
            && (message.role === 'tool' || message.role === 'toolgroup'
              || message.role === 'approx' || message.role === 'assistant'));
        if (existingWork && !hasRawWorkAfterArchive) continue;

        const entries = segment.map((message, index) => ({
          msg: message,
          index,
          work: isArchivableTool(message)
            || ((message.role === 'approx' || message.role === 'assistant') && index < finalLocal),
        }));
        const workEntries = entries.filter((entry) => entry.work && entry.index < finalLocal);
        if (!workEntries.length) continue;

        const tools = [];
        const notes = [];
        for (const entry of workEntries) {
          const message = entry.msg;
          if (message.role === 'workgroup') {
            notes.push(...(message.notes ?? []));
            flattenArchiveTools(message, tools);
          } else if (isArchivableTool(message)) {
            flattenArchiveTools(message, tools);
          } else if (message.role === 'approx' || message.role === 'assistant') {
            notes.push(message);
          }
        }
        if (!tools.length && !notes.length) continue;
        const firstWork = workEntries[0].index;
        if (!notes.length && tools.length) {
          notes.push({
            role: 'note',
            text: `Tool phase · ${tools.length} call${tools.length === 1 ? '' : 's'} completed`,
            time: segment[firstWork]?.time,
            markdown: false,
            synthetic: true,
          });
        }

        const toolGroup = tools.length ? this.makeArchivedToolGroup(tools, segment, workEntries) : null;
        const workgroup = existingWork ?? {
          role: 'workgroup',
          title: 'Work',
          text: '',
          time: segment[firstWork]?.time,
          enter: 1,
          notes: [],
          tools: [],
          expanded: false,
          expandAnim: new Spring(0, { stiff: 18, damp: 0.86 }),
          markdown: false,
          archived: true,
        };
        workgroup.notes = notes;
        workgroup.tools = toolGroup ? [toolGroup] : [];
        workgroup.archived = true;
        workgroup._lines = null;

        const rebuilt = [];
        for (let index = 0; index < segment.length; index++) {
          if (index === firstWork) rebuilt.push(workgroup);
          if (entries[index].work && index < finalLocal) continue;
          rebuilt.push(segment[index]);
        }
        messages.splice(userIndex + 1, segment.length, ...rebuilt);
        changed = true;
        again = true;
        break;
      }
    }
    if (changed) {
      if (this.st.jump) this.refreshJump();
      this.s.invalidate();
    }
    return changed;
  },

  makeArchivedToolGroup(tools, segment, workEntries) {
    const sourceGroup = workEntries.map((entry) => entry.msg)
      .find((message) => message.role === 'toolgroup' && message.modelTitle && message.title)
      ?? workEntries.map((entry) => entry.msg)
        .find((message) => message.role === 'toolgroup' && message.title);
    const namedTool = tools.find((tool) => tool.modelGroupTitle && (tool.groupTitle || tool.title));
    return {
      role: 'toolgroup',
      callId: `tool-group-${++this._toolGroupSeq}`,
      title: sourceGroup?.title || namedTool?.groupTitle || 'Tool Calls',
      modelTitle: !!sourceGroup?.modelTitle || !!namedTool,
      tools,
      text: '',
      time: segment[workEntries[0].index]?.time,
      enter: 1,
      expanded: false,
      expandAnim: new Spring(0, { stiff: 18, damp: 0.86 }),
      markdown: false,
      archived: true,
    };
  },

  appendTurnFileChanges(turn) {
    if (!turn || turn.changesDelivered) return null;
    turn.changesDelivered = true;
    const journal = this.backend?.mutationsForCalls?.(turn.mutationCallIds ?? []) ?? [];
    const transcript = collectLatestTurnMutations(this.st.msgs);
    const files = buildFileChanges([...(turn.mutations ?? []), ...journal, ...transcript], this.st.cwdPath);
    if (!files.length) return null;
    const summary = summarizeFileChanges(files);
    const message = this.push({
      role: 'system',
      subtype: 'changeset',
      title: 'FILE CHANGES',
      text: '',
      files,
      summary,
      expanded: false,
      expandAnim: new Spring(0, { stiff: 18, damp: 0.86 }),
      markdown: false,
    });
    this.st.toolFocus = message;
    return message;
  },

  appendDetachedFileChanges() {
    if (!this._detachedMutations.length) return null;
    const mutations = this._detachedMutations.splice(0);
    return this.appendTurnFileChanges({ mutations, mutationCallIds: [] });
  },

  toolGroupFor(tool) {
    for (const message of this.st.msgs) {
      const group = findToolGroup(message, tool);
      if (group) return group;
    }
    return null;
  },

  beginStream(text, cps = 190) {
    const message = this.push({ role: 'approx', text, streaming: true, streamChars: 0 });
    message._cps = cps;
    message._total = totalChars(message, this.bodyWidth());
    this.st.busy = true;
    this.st.elapsed = 0;
    return message;
  },

  finishStream(message) {
    message.streaming = false;
    message.streamChars = Infinity;
    this.st.turns++;
    this.st.ctxUse.set(clamp(this.st.ctxUse.target + 0.045 + Math.random() * 0.03, 0, 1));
    if (this.harness) this.harness.emit({ event: 'streamEnd' });
    this.noteScriptedDelivery();
  },

  injectTool(input) {
    const tool = this.push({
      role: 'tool',
      name: String(input.name ?? 'tool'),
      meta: input.meta != null ? String(input.meta) : undefined,
      text: String(input.text ?? ''),
      running: true,
      progress: 0,
      expanded: false,
      expandAnim: new Spring(0, { stiff: 18, damp: 0.86 }),
    });
    const group = this.toolGroupFor(tool);
    this.st.toolFocus = group && !group.expanded ? group.callId : (tool.callId ?? tool);
    tool._dur = Math.max(50, Number(input.dur) || 1000);
    tool._t = 0;
    this.st.busy = true;
    this.scrollToBottom();
    this.later(() => {
      tool.running = false;
      tool.progress = null;
      this.st.busy = false;
      if (this.harness) this.harness.emit({ event: 'toolEnd', name: tool.name });
    }, tool._dur + 50);
  },

  dumpFrame(cols, rows) {
    const width = clamp(Number(cols) || this.s.w, 20, 400);
    const height = clamp(Number(rows) || this.s.h, 8, 200);
    const previous = this.s;
    this.s = new Screen({ columns: width, rows: height, isTTY: true, write() {}, on() {} });
    this.update(0, this.clock.t);
    this.render(this.clock.t);
    const ansi = serializeScreen(this.s);
    this.s = previous;
    this.s.invalidate();
    return { cols: width, rows: height, ansi };
  },

  snapshot() {
    const snap = (message) => ({
      role: message.role,
      text: message.text,
      ...(message.title ? { title: message.title } : {}),
      ...(message.name ? { name: message.name } : {}),
      ...(message.meta ? { meta: message.meta } : {}),
      ...(message.streaming ? { streaming: true } : {}),
      ...(message.running ? { running: true } : {}),
      ...(message.role === 'toolgroup'
        ? { expanded: !!message.expanded, tools: message.tools.map(snap) } : {}),
      ...(message.role === 'workgroup' ? {
        expanded: !!message.expanded,
        notes: (message.notes ?? []).map(snap),
        tools: (message.tools ?? []).map(snap),
      } : {}),
      ...(message.role === 'system' && message.subtype === 'changeset' ? {
        subtype: 'changeset',
        expanded: !!message.expanded,
        summary: { ...message.summary },
        files: (message.files ?? []).map((file) => ({
          path: file.path,
          displayPath: file.displayPath,
          kind: file.kind,
          added: file.added,
          removed: file.removed,
          binary: !!file.binary,
          diff: (file.diff ?? []).map((line) => ({ ...line })),
        })),
      } : {}),
    });
    return this.st.msgs.map(snap);
  },

  resetTranscriptView() {
    this.st.msgs = [];
    this.liveAssistant = null;
    this._pendingLiveDelta = '';
    this.liveTools.clear();
    this._activeTurn = null;
    this._detachedMutations = [];
    this.st.messageQueue = [];
    this.st.queueGhosts = [];
    this.st.queueHits = [];
    this.st.queueAnim.set(0, true);
    this._tokenEvents = [];
    this.st.tps.fill(0);
    this.st.tpsNow = 0;
    this.st.ctxUse.set(0, true);
    this.st.toolFocus = null;
    this.st.scroll = 0;
    this.st.scrollTarget = 0;
    this.st.scrollSpring.set(0, true);
    this.st.railTicks = [];
    this.st.railHover = -1;
    this.st.railAmt.set(0, true);
    this.st.jump = false;
    this.st.jumpAnim.set(0, true);
    this.st.jumpResults = [];
    this.st.jumpDepth = 0;
    this.st.jumpParent = null;
    this.cancelMessageEdit(false);
    this.st.redo = null;
    this.st.pointerDown = null;
    this.st.textSelection = null;
    this.s.invalidate();
  },

  clearTranscript() {
    const reset = this.backend?.resetContext;
    this.resetTranscriptView();
    if (!reset) {
      this.toast(this.harness?.attached ? 'view cleared · driver context unchanged' : 'context cleared', 'ok');
      return;
    }
    this.st.busy = true;
    this.toast('starting a clean context', 'info');
    void reset.call(this.backend).catch((error) => {
      this.st.busy = false;
      this.onBackendEvent({ type: 'error', error: String(error?.message ?? error) });
    });
  },

  newConversation() {
    const create = this.backend?.newConversation;
    this.resetTranscriptView();
    if (!create) {
      this.seed();
      this.toast('new conversation ready', 'ok');
      return;
    }
    this.st.busy = true;
    this.toast('starting a new conversation', 'info');
    void create.call(this.backend).catch((error) => {
      this.st.busy = false;
      this.onBackendEvent({ type: 'error', error: String(error?.message ?? error) });
    });
  },

  toast(text, kind = 'info') {
    this.st.toast = text;
    this.st.toastKind = kind;
    this.st.toastMax = 2.4;
    this.st.toastLife = 2.4;
  },

  recordOutputTokens(delta) {
    const tokens = estimateTokens(delta);
    if (tokens <= 0) return;
    this._tokenEvents.push({ at: this.clock.t, tokens });
  },
};

function stamp() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function serializeScreen(screen) {
  let output = '';
  for (let y = 0; y < screen.h; y++) {
    let fg = -2;
    let bg = -2;
    let attributes = 255;
    for (let x = 0; x < screen.w; x++) {
      const index = y * screen.w + x;
      const character = screen.ch[index];
      if (character === '') continue;
      if (screen.fg[index] !== fg || screen.bg[index] !== bg || screen.at[index] !== attributes) {
        fg = screen.fg[index];
        bg = screen.bg[index];
        attributes = screen.at[index];
        output += sgr(fg, bg, attributes);
      }
      output += character;
    }
    output += `${RESET}\n`;
  }
  return output;
}

function estimateTokens(text) {
  let cjk = 0;
  let ascii = 0;
  let punctuation = 0;
  for (const character of String(text ?? '')) {
    const codePoint = character.codePointAt(0);
    if ((codePoint >= 0x2e80 && codePoint <= 0x9fff)
      || (codePoint >= 0xac00 && codePoint <= 0xd7af)) cjk++;
    else if (/\s/.test(character)) continue;
    else if (codePoint < 128 && /[\p{L}\p{N}]/u.test(character)) ascii++;
    else punctuation++;
  }
  return cjk + ascii / 4 + punctuation / 2;
}

function normalizeTitle(value) {
  return String(value ?? '').trim().toLowerCase();
}

function isArchivableTool(message) {
  return message?.role === 'tool' || message?.role === 'toolgroup' || message?.role === 'workgroup';
}

function findFinalApprox(segment) {
  for (let index = segment.length - 1; index >= 0; index--) {
    const message = segment[index];
    if (message?.role !== 'approx' && message?.role !== 'assistant') continue;
    if (String(message.stopReason ?? '').toLowerCase() !== 'tooluse') return index;
  }
  return -1;
}

function flattenArchiveTools(message, output) {
  if (message?.role === 'tool') {
    output.push(message);
    return;
  }
  if (message?.role === 'toolgroup') {
    for (const tool of message.tools ?? []) output.push(tool);
    return;
  }
  if (message?.role === 'workgroup') {
    for (const group of message.tools ?? []) {
      for (const tool of group.tools ?? []) output.push(tool);
    }
  }
}

function collectLatestTurnMutations(messages) {
  const userIndex = messages.findLastIndex((message) => message?.role === 'user');
  const mutations = [];
  const takeTool = (tool) => { if (tool?.mutation) mutations.push(tool.mutation); };
  for (const message of messages.slice(userIndex + 1)) {
    if (message.role === 'tool') takeTool(message);
    if (message.role === 'toolgroup') for (const tool of message.tools ?? []) takeTool(tool);
    if (message.role === 'workgroup') {
      for (const group of message.tools ?? []) for (const tool of group.tools ?? []) takeTool(tool);
    }
  }
  return mutations;
}

function findToolGroup(container, tool) {
  if (container?.role === 'toolgroup' && container.tools?.includes(tool)) return container;
  if (container?.role === 'workgroup') {
    for (const group of container.tools ?? []) if (group.tools?.includes(tool)) return group;
  }
  return null;
}

function fallbackToolGroupTitle(tools) {
  const names = new Set((tools ?? []).map((tool) => String(tool.name ?? '').toLowerCase()));
  if ([...names].every((name) => ['read', 'find', 'grep', 'ls', 'glob'].includes(name))) return 'Inspect project context';
  if ([...names].every((name) => ['write', 'edit', 'apply_patch'].includes(name))) return 'Update project files';
  if ([...names].every((name) => ['bash', 'shell', 'shell_command'].includes(name))) return 'Run project commands';
  return 'Work through project task';
}
