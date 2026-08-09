import { clamp } from './anim.js';
import { slashSuggestions } from './commands.js';
import {
  setComposerInput, insertComposerText, deleteComposerBackward, deleteComposerForward,
  deleteComposerWord, moveComposerCursor, moveComposerLineEdge,
} from './composer-state.js';
import { SUGGESTION_ROWS } from './ui/composer.js';
import { SPLASH_MS } from './ui/splash.js';

const WHEEL_STEP = 3;

/** Keyboard and pointer routing plus composer-local navigation. */
export const inputMethods = {
  onKey(k) {
    if (!this.alive) return;

    // Focus reporting is disabled because an IME candidate window can generate
    // focus churn in Windows Terminal. Ignore stray sequences from older hosts.
    if (k.name === 'focusin' || k.name === 'focusout') {
      return;
    }
    this.requestFrame();

    if (this.st.phase === 'splash') {
      this.st.splashMs = Math.max(this.st.splashMs, SPLASH_MS - 420);
      return;
    }

    if (k.ctrl && k.name === 'c') return this.quit();
    if (!k.mouse && k.name !== 'focusin' && k.name !== 'focusout') this.st.textSelection = null;

    if (this.st.effortPicker?.open) {
      if (k.name === 'mousemove') return this.effortPickerPointer(k.x, k.y, false);
      if (k.name === 'mousedown') return this.effortPickerPointer(k.x, k.y, true);
      return this.effortPickerKey(k);
    }

    if (this.st.questionnaire?.open) {
      if (k.name === 'mousemove') return this.questionnairePointer(k.x, k.y, false);
      if (k.name === 'mousedown') return this.questionnairePointer(k.x, k.y, true);
      return this.questionnaireKey(k);
    }

    if (this.st.status?.open) {
      if (k.name === 'mousedown') return this.statusPointer(k.x, k.y);
      return this.statusKey(k);
    }

    // Approde is a docked sidebar. When focused it captures the keyboard; when
    // merely open it stays visible but lets the composer keep typing, while
    // still handling clicks that land inside its panel.
    if (this.st.approde?.open) {
      if (k.name === 'mousemove') { if (this.approdePointer(k.x, k.y, false)) return; }
      else if (k.name === 'mousedown') { if (this.approdePointer(k.x, k.y, true)) return; }
      else if (this.st.approde.focused && (k.name === 'wheelup' || k.name === 'wheeldown')) {
        return this.moveApprode(k.name === 'wheeldown' ? 1 : -1);
      }
      else if (this.st.approde.focused && !k.mouse) return this.approdeKey(k);
    }

    if (this.st.view === 'git') return this.gitKey(k);

    if (this.st.directoryPicker?.open) return this.directoryKey(k);
    // Composer suggestions are the active prompt layer. Let them consume keyboard
    // navigation before a focused Plan panel sees the same arrows/Enter.
    if (this.st.plan?.focused && !k.mouse && !this.composerSuggestionOpen()) return this.planKey(k);
    if (this.st.messageEdit.mode === 'confirm') return this.rewindConfirmKey(k);
    if (this.st.sessionPicker.open) return this.sessionKey(k);
    if (this.st.jump) return this.jumpKey(k);
    if (this.st.view === 'settings') return this.settingsKey(k);

    if (k.name === 'wheelup' || k.name === 'wheeldown') {
      const dir = k.name === 'wheeldown' ? 1 : -1;
      if (this.st.palette) return this.paletteMove(dir * WHEEL_STEP);
      if (this.fileMentionOpen()) return this.moveFileMention(dir * WHEEL_STEP, SUGGESTION_ROWS);
      if (this.slashOpen()) return this.slashMove(dir * WHEEL_STEP);
      return this.scrollBy(dir * WHEEL_STEP);
    }
    if (k.name === 'mousemove') {
      if (this.planPointer(k.x, k.y, false)) return;
      if (this.st.palette) return this.palettePointer(k.x, k.y, false);
      return this.railHoverAt(k.x, k.y);
    }
    if (k.name === 'mousedrag') {
      if (this.planPointerDrag(k.x, k.y)) return;
      return this.dragTextSelection(k.x, k.y);
    }
    if (k.name === 'mouseup') {
      if (this.planPointerUp(k.x, k.y)) return;
      return this.finishPointer(k.x, k.y);
    }
    if (k.name === 'mousedown') {
      if (this.planPointerDown(k.x, k.y)) return;
      const modeHit = this.st.modeHit;
      if (modeHit && k.y === modeHit.y && k.x >= modeHit.x1 && k.x <= modeHit.x2) {
        return this.cycleMode();
      }
      if (this.st.palette) return this.palettePointer(k.x, k.y, true);
      if (this.queuedDeleteAt(k.x, k.y)) return;
      const tk = this.railTickAt(k.x, k.y);
      if (tk) {
        const first = this.st.railTicks[0];
        if (tk === first && tk.logical) return this.jumpToMessageRow(tk.index, -(tk.rawDocY ?? 0));
        return this.jumpToMessage(tk.index);
      }
      const hit = this.messageAt(k.x, k.y);
      if (hit?.msg._redoHit && k.y === hit.msg._redoHit.y
        && k.x >= hit.msg._redoHit.x1 && k.x <= hit.msg._redoHit.x2) return this.performRedo();
      if (hit?.msg.role === 'tool' && hit.offset === 1) return this.toggleTool(hit.msg);
      if (hit?.msg.role === 'toolgroup') {
        if (hit.line?.kind === 'toolchildhead') return this.toggleTool(hit.line.tool);
        if (hit.offset === 1) return this.toggleToolGroup(hit.msg);
      }
      if (hit?.msg.role === 'workgroup') {
        if (hit.line?.kind === 'workfilehead') return this.toggleFileEditGroup(hit.line.group);
        if (hit.line?.kind === 'worktoolhead') return this.toggleToolGroup(hit.line.group);
        if (hit.line?.kind === 'toolchildhead') return this.toggleTool(hit.line.tool);
        if (hit.line?.kind === 'workgrouphead' || hit.offset === 1) return this.toggleWorkGroup(hit.msg);
      }
      if (hit?.msg.role === 'system' && hit.msg.subtype === 'changeset'
        && (hit.line?.kind === 'changesethead' || hit.offset === 1)) return this.toggleChangeset(hit.msg);
      this.beginPointer(k.x, k.y, hit);
      if (hit?.msg.role === 'user') this.pressUserMessage(hit.msg);
      return;
    }

    if (k.ctrl && k.name === 'd' && !this.st.input) return this.quit();
    if (k.ctrl && k.name === 'r') {
      this.s.invalidate();
      this.toast('redrawn', 'ok');
      return;
    }

    if (this.st.palette) return this.paletteKey(k);

    if (k.ctrl && k.name === 'p') return this.openPalette();
    if (k.ctrl && k.name === 'k') return this.openGit();
    if (k.ctrl && k.name === 'o') return this.openSettings();
    if (k.ctrl && k.name === 'g') return this.openJump();
    if (k.ctrl && k.name === 's') return this.openSessions();
    if (k.ctrl && k.name === 'l') return this.clearTranscript();
    if (k.ctrl && k.name === 't') return this.cycleAccent();
    if (k.ctrl && k.name === 'u') return this.toggleFocusedTool();
    if (k.ctrl && k.name === 'e') return this.keyboardEditMessage();
    if (k.ctrl && k.name === 'b') return this.toggleApprode();
    if (k.alt && k.name === 'r') return this.performRedo();
    if (k.alt && k.name.toLowerCase() === 'p') return this.togglePlanExpanded();
    if (k.shift && k.name === 'tab') return this.cycleMode();
    if (k.alt && k.name === 'backspace' && this.st.messageQueue.length) return this.removeQueuedTurn();

    if (this.st.plan?.approval === 'pending' && !this.st.input) {
      if (k.name.toLowerCase() === 'y' || k.name === 'enter') return this.approvePlan();
      if (k.name.toLowerCase() === 'n') return this.rejectPlan();
    }
    if (this.st.messageEdit.mode === 'selected' && k.alt && (k.name === 'up' || k.name === 'down')) {
      return this.cycleSelectedUser(k.name === 'down' ? 1 : -1);
    }

    const fileMentionOpen = this.fileMentionOpen();
    const slashOpen = this.slashOpen();
    if ((fileMentionOpen || slashOpen) && (k.name === 'up' || k.name === 'down')) {
      if (fileMentionOpen) this.moveFileMention(k.name === 'down' ? 1 : -1, SUGGESTION_ROWS);
      else this.slashMove(k.name === 'down' ? 1 : -1);
      return;
    }
    if (fileMentionOpen && k.name === 'tab') return this.acceptFileMention();
    if (slashOpen && k.name === 'tab') {
      const item = this.st.slashMatches[this.st.slashIndex];
      setComposerInput(this.st, item.terminal ? item.name : `${item.name} `);
      this.refreshComposerSuggestions();
      return;
    }

    switch (k.name) {
      case 'escape':
        if (this.st.messageEdit.mode === 'editing' || this.st.messageEdit.mode === 'selected') {
          this.cancelMessageEdit();
        } else if (fileMentionOpen) {
          this.closeFileMention({ dismiss: true });
        } else if (this.st.busy) {
          this.interrupt();
        } else if (this.st.input) {
          setComposerInput(this.st, '');
          this.refreshComposerSuggestions();
        }
        return;
      case 'enter':
        if (this.st.messageEdit.mode === 'selected') return this.beginMessageEdit(this.st.messageEdit.target);
        if (k.shift || k.alt) {
          insertComposerText(this.st, '\n');
          this.refreshComposerSuggestions();
          return;
        }
        if (fileMentionOpen) return this.acceptFileMention();
        if (slashOpen) {
          const item = this.st.slashMatches[this.st.slashIndex];
          if (item) {
            setComposerInput(this.st, item.terminal ? item.name : `${item.name} `);
            this.refreshComposerSuggestions();
            if (!item.terminal) return;
          }
        }
        return this.submit();
      case 'backspace':
        deleteComposerBackward(this.st);
        this.refreshComposerSuggestions();
        return;
      case 'delete':
        deleteComposerForward(this.st);
        this.refreshComposerSuggestions();
        return;
      case 'left':
        moveComposerCursor(this.st, -1);
        this.refreshComposerSuggestions();
        return;
      case 'right':
        moveComposerCursor(this.st, 1);
        this.refreshComposerSuggestions();
        return;
      case 'up':
        return this.historyPrev();
      case 'down':
        return this.historyNext();
      case 'pageup':
        return this.scrollBy(-Math.max(1, this.viewport().h - 2));
      case 'pagedown':
        return this.scrollBy(Math.max(1, this.viewport().h - 2));
      case 'home':
        if (this.st.input || this.st.messageEdit.mode === 'editing') return moveComposerLineEdge(this.st, false);
        return this.scrollTo(0);
      case 'end':
        if (this.st.input || this.st.messageEdit.mode === 'editing') return moveComposerLineEdge(this.st, true);
        return this.scrollToBottom();
      case 'space':
        insertComposerText(this.st, ' ');
        this.refreshComposerSuggestions();
        return;
      case 'tab':
        return;
      default:
        break;
    }

    if (k.ctrl && k.name === 'j') {
      insertComposerText(this.st, '\n');
      this.refreshComposerSuggestions();
      return;
    }
    if (k.ctrl && k.name === 'w') {
      deleteComposerWord(this.st);
      this.refreshComposerSuggestions();
      return;
    }
    if (k.ctrl || k.alt) return;

    if (k.printable) {
      insertComposerText(this.st, k.name);
      this.refreshComposerSuggestions();
      this.st.focusAnim.set(1);
    }
  },

  historyPrev() {
    const h = this.st.history;
    if (!h.length) return;
    if (this.st.histIdx < 0) this.st.draft = this.st.input;
    this.st.histIdx = this.st.histIdx < 0 ? h.length - 1 : Math.max(0, this.st.histIdx - 1);
    setComposerInput(this.st, h[this.st.histIdx]);
    this.refreshComposerSuggestions();
  },

  historyNext() {
    const h = this.st.history;
    if (this.st.histIdx < 0) return;
    this.st.histIdx++;
    if (this.st.histIdx >= h.length) {
      this.st.histIdx = -1;
      setComposerInput(this.st, this.st.draft);
      this.st.draft = '';
    } else {
      setComposerInput(this.st, h[this.st.histIdx]);
    }
    this.refreshComposerSuggestions();
  },

  slashOpen() {
    return this.st.slashMatches.length > 0 && this.st.input.startsWith('/');
  },

  composerSuggestionOpen() {
    return this.fileMentionOpen() || this.slashOpen();
  },

  refreshComposerSuggestions() {
    this.refreshSlash();
    void this.refreshFileMention();
  },

  refreshSlash() {
    const inp = this.st.input;
    if (inp.startsWith('/')) {
      this.st.slashMatches = slashSuggestions(this, inp);
      this.st.slashIndex = 0;
      this.st.slashScroll = 0;
    } else {
      this.st.slashMatches = [];
      this.st.slashScroll = 0;
    }
    this.syncComposerSuggestionAnimation();
  },

  slashMove(d) {
    const n = this.st.slashMatches.length;
    if (!n) return;
    this.st.slashIndex = (this.st.slashIndex + d + n) % n;
    const rows = Math.min(SUGGESTION_ROWS, n);
    if (this.st.slashIndex < this.st.slashScroll) {
      this.st.slashScroll = this.st.slashIndex;
    } else if (this.st.slashIndex >= this.st.slashScroll + rows) {
      this.st.slashScroll = this.st.slashIndex - rows + 1;
    }
    this.st.slashScroll = clamp(this.st.slashScroll, 0, Math.max(0, n - rows));
    this.st.slashAnim.set(1);
  },

  interrupt() {
    const abortBackend = !!this.backend && this.st.busy;
    const turn = this._activeTurn;
    if (turn) turn.interrupted = true;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    for (const m of this.st.msgs) {
      if (m.streaming) {
        m.streaming = false;
        m.streamChars = Infinity;
      }
      if (m.running) m.running = false;
    }
    this.liveAssistant = null;
    for (const tool of this.liveTools.values()) tool.running = false;
    this.liveTools.clear();
    this.toast('interrupted', 'warn');
    if (abortBackend) {
      void this.backend.abort()
        .catch((error) => this.toast(String(error?.message ?? error), 'warn'))
        .finally(() => {
          if (!turn) return;
          turn.promiseDone = true;
          turn.runtimeSettled = true;
          this.tryReleaseTurn(turn);
        });
    } else if (turn) {
      turn.promiseDone = true;
      turn.runtimeSettled = true;
      this.tryReleaseTurn(turn);
    } else {
      this.st.busy = false;
    }
  },
};
