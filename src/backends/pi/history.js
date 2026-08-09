import { mergeMutations, restoreMutations } from './helpers.js';

export class PiHistoryMethods {
  /** Resolve a visible user turn to the append-only session entry behind it. */
  resolveUserEntry(text) {
    this.requireSession();
    const wanted = String(text ?? '');
    const matches = this.session.getUserMessagesForForking().filter((entry) => entry.text === wanted);
    return matches.at(-1)?.entryId ?? null;
  }

  /** Resolve by visible turn position first, avoiding the wrong branch when two
   * user messages have identical text. Text is only a consistency fallback. */
  resolveUserEntryAt(index, text = '') {
    this.requireSession();
    const entries = this.session.getUserMessagesForForking();
    const candidate = entries[Number(index)];
    if (candidate && (!text || candidate.text === String(text))) return candidate.entryId;
    return this.resolveUserEntry(text);
  }

  mutationsForCalls(callIds = []) {
    return callIds.map((id) => this.mutationJournal.get(String(id))).filter(Boolean);
  }

  persistFileChanges(callId, fileChanges, manager = this.session?.sessionManager) {
    if (!manager?.appendCustomEntry || !fileChanges?.length) return false;
    manager.appendCustomEntry('approx-file-changes', { callId: String(callId), fileChanges });
    return true;
  }

  /**
   * Branch to immediately before a user message and restore every captured file
   * mutation in the abandoned suffix. Returns the old leaf needed for one redo.
   */
  async rewindContext(entryId, mutations = [], mutationCallIds = []) {
    this.requireSession();
    if (this.session.isStreaming) {
      await this.session.abort();
      await this.session.waitForIdle();
    }
    const target = this.session.sessionManager.getEntry(entryId);
    if (!target || target.type !== 'message' || target.message?.role !== 'user') {
      throw new Error('Approx could not locate that user message in the session tree');
    }
    const oldLeafId = this.session.sessionManager.getLeafId();
    const result = await this.session.navigateTree(entryId, { summarize: false });
    if (result.cancelled) throw new Error('Approx rewind was cancelled');
    const manager = this.session.sessionManager;
    // AgentSession normally performs this parent jump itself. Verify it and
    // rebuild the live agent context explicitly so the abandoned suffix cannot
    // survive in an adapter/provider cache after the visible UI has rewound.
    if (typeof manager.buildSessionContext === 'function') {
      const expectedLeaf = target.parentId ?? null;
      const actualLeaf = manager.getLeafId();
      if (actualLeaf !== expectedLeaf) {
        throw new Error('Approx rewind did not land before the edited user message');
      }
      const branch = manager.getBranch();
      if (branch.some((entry) => entry.id === entryId)) {
        throw new Error('Approx rewind context still contains the edited branch');
      }
      if (this.session.agent?.state) this.session.agent.state.messages = manager.buildSessionContext().messages;
    }
    const completeMutations = mergeMutations(mutations,
      mutationCallIds.map((id) => this.mutationJournal.get(String(id))).filter(Boolean));
    restoreMutations(completeMutations, 'before');
    this.restorePlanFromCurrentBranch('rewound');
    this.emitContext();
    return { oldLeafId, entryId, editorText: result.editorText ?? '', mutations: completeMutations };
  }

  /** Rejoin the abandoned branch and replay its captured file post-images once. */
  async redoRewind(token, mutations = [], abandonedMutations = []) {
    this.requireSession();
    const oldLeafId = token?.oldLeafId;
    if (!oldLeafId || !this.session.sessionManager.getEntry(oldLeafId)) {
      throw new Error('Approx redo branch is no longer available');
    }
    if (this.session.isStreaming) {
      await this.session.abort();
      await this.session.waitForIdle();
    }
    const result = await this.session.navigateTree(oldLeafId, { summarize: false });
    if (result.cancelled) throw new Error('Approx redo was cancelled');
    restoreMutations(abandonedMutations, 'before');
    restoreMutations(mutations, 'after');
    this.restorePlanFromCurrentBranch('redo');
    this.emitContext();
    return true;
  }

}
