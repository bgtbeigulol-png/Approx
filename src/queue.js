// Turn queue + delivery state machine. Queued prompts stay out of the transcript
// and model context until the preceding turn has delivered its final assistant
// message and the runtime has fully settled.

import { Spring } from './anim.js';

export const MAX_QUEUED_TURNS = 4;

// Row springs: `anim` is presence (0 hidden → 1 fully queued) driving the
// slide/fade entrance and the ghost-collapse exit. `y` is the reflow offset: a
// live row's slot below a collapsing ghost is a fixed base position, and when
// the ghost is finally pruned the rows below start one slot too low (offset +1)
// and glide up to their settled slots so the list closes with a curve.
export const QUEUE_ROW_SPRING = { stiff: 16, damp: 0.86 };
export const QUEUE_GLIDE_SPRING = { stiff: 22, damp: 0.92 };

export const queueMethods = {
  turnInFlight() {
    if (this._activeTurn || this.st.busy) return true;
    try {
      return this.backend?.isBusy?.() === true;
    } catch {
      return false;
    }
  },

  enqueueTurn(text, source = 'user') {
    if (this.st.messageQueue.length >= MAX_QUEUED_TURNS) {
      this.toast(`queue full · ${MAX_QUEUED_TURNS}/${MAX_QUEUED_TURNS} · alt+backspace drops the last`, 'warn');
      return false;
    }
    const item = {
      id: ++this._queueSeq,
      text: String(text),
      source,
      // base is the row's fixed enqueue slot (monotonic id - 1). Ghosts keep
      // theirs while they fade; a removal above glides a row up via the y
      // spring instead of rewriting the index, so the list reflows smoothly.
      base: this._queueSeq - 1,
      y: new Spring(0, QUEUE_GLIDE_SPRING),
      anim: new Spring(0, QUEUE_ROW_SPRING),
    };
    item.anim.set(1, this.st.reduceMotion);
    this.st.messageQueue.push(item);
    this.st.queueAnim.set(1, this.st.reduceMotion);
    this.st.queuePulse.set(1, true);
    this.st.queuePulse.set(0);
    this.toast(`queued ${this.st.messageQueue.length}/${MAX_QUEUED_TURNS} · sends after final Approx`, 'info');
    this.scrollToBottom();
    return true;
  },

  removeQueuedTurn(index = this.st.messageQueue.length - 1) {
    if (index < 0 || index >= this.st.messageQueue.length) {
      return this.toast('message queue is empty', 'warn');
    }
    const [removed] = this.st.messageQueue.splice(index, 1);
    this.spawnQueueGhost(removed);
    if (!this.st.messageQueue.length && !this.st.queueGhosts.length) {
      this.st.queueAnim.set(0, this.st.reduceMotion);
    }
    this.st.queuePulse.set(1, true);
    this.st.queuePulse.set(0);
    this.st.queueHits = [];
    this.toast(`removed queued message · ${this.st.messageQueue.length}/${MAX_QUEUED_TURNS}`, 'ok');
    this.s.invalidate();
    this.clampScroll();
    return removed;
  },

  queuedDeleteAt(x, y) {
    const hit = (this.st.queueHits ?? []).find((candidate) =>
      y === candidate.y && x >= candidate.x1 && x <= candidate.x2);
    if (!hit) return false;
    this.removeQueuedTurn(hit.index);
    return true;
  },

  /** Called for every assistant message_end. Only a non-toolUse message delivers. */
  noteAssistantDelivery(stopReason) {
    const turn = this._activeTurn;
    if (!turn || String(stopReason ?? '').toLowerCase() === 'tooluse') return;
    turn.finalDelivered = true;
    this.tryReleaseTurn(turn);
  },

  noteRuntimeSettled() {
    const turn = this._activeTurn;
    if (!turn) {
      this.st.busy = false;
      void this.applyPendingRuntimeChanges()
        .catch((error) => this.toast(String(error?.message ?? error), 'warn'))
        .finally(() => this.drainMessageQueue());
      return;
    }
    turn.runtimeSettled = true;
    this.tryReleaseTurn(turn);
  },

  notePromptPromiseDone(turn, failed = false) {
    if (!turn) return;
    turn.promiseDone = true;
    turn.failed ||= failed;
    // A rejected prompt has already left the runtime call stack. This fallback
    // also covers providers that omit agent_settled on a transport failure.
    if (failed) turn.runtimeSettled = true;
    this.tryReleaseTurn(turn);
  },

  noteScriptedDelivery() {
    const turn = this._activeTurn;
    if (!turn) {
      this.archiveCompletedWork();
      this.st.busy = false;
      return;
    }
    turn.finalDelivered = true;
    turn.promiseDone = true;
    turn.runtimeSettled = true;
    this.tryReleaseTurn(turn);
  },

  tryReleaseTurn(turn) {
    if (!turn || turn !== this._activeTurn || turn.releasing) return false;
    const terminal = turn.finalDelivered || turn.interrupted || turn.failed;
    if (!terminal || !turn.promiseDone || !turn.runtimeSettled) return false;
    turn.releasing = true;
    // A WORK envelope is a completed-turn view. Waiting until the request
    // promise and the runtime boundary both land prevents a phase-level
    // settled event from freezing only the first slice of tool activity.
    this.archiveCompletedWork();
    this.appendTurnFileChanges(turn);
    this._activeTurn = null;
    this.st.busy = false;
    this.st.elapsed = 0;
    void this.applyPendingRuntimeChanges()
      .catch((error) => this.toast(String(error?.message ?? error), 'warn'))
      .finally(() => this.drainMessageQueue());
    return true;
  },

  drainMessageQueue() {
    if (this.turnInFlight() || !this.st.messageQueue.length) return false;
    const item = this.st.messageQueue.shift();
    this.spawnQueueGhost(item);
    if (!this.st.messageQueue.length && !this.st.queueGhosts.length) {
      this.st.queueAnim.set(0, this.st.reduceMotion);
    }
    this.st.queuePulse.set(1, true);
    this.st.queuePulse.set(0);
    this.st.queueHits = [];
    this.dispatchTurn(item.text, { source: item.source, queued: true });
    return true;
  },

  /**
   * Keep a removed row alive as a ghost so the queue can play its exit (fade +
   * collapse) instead of cutting it. The ghost is pruned once its presence
   * spring settles at 0, which then lets every live row below it glide up.
   */
  spawnQueueGhost(item) {
    if (this.st.reduceMotion) return;
    const ghost = {
      id: item.id,
      text: item.text,
      source: item.source,
      base: item.base,
      y: new Spring(0, QUEUE_GLIDE_SPRING),
      anim: new Spring(1, QUEUE_ROW_SPRING),
      leaving: true,
    };
    ghost.anim.set(0, this.st.reduceMotion);
    this.st.queueGhosts.push(ghost);
  },

  /** Drop settled ghosts and glide the live rows below them up one slot. */
  pruneQueueGhosts() {
    const st = this.st;
    let changed = false;
    for (let i = st.queueGhosts.length - 1; i >= 0; i--) {
      const ghost = st.queueGhosts[i];
      if (!ghost.anim.settled) continue;
      st.queueGhosts.splice(i, 1);
      changed = true;
      // The merged list just lost the ghost's slot, so every live row below it
      // would snap up one row. Start them one slot low (offset +1) and let the
      // glide spring ease them into their settled position instead.
      for (const item of st.messageQueue) {
        if (item.base <= ghost.base) continue;
        item.y.v += 1;
        item.y.set(0, st.reduceMotion);
      }
    }
    if (!changed) return;
    if (!st.messageQueue.length && !st.queueGhosts.length) {
      st.queueAnim.set(0, st.reduceMotion);
    }
    st.queueHits = [];
    this.s.invalidate();
  },
};
