import {
  applyPlanOperation, buildPlanTurnInjection, createPlanState, hydratePlanState, serializePlanState,
} from '../../plan.js';
import { formatError, restorePlanState } from './helpers.js';

export class PiPlanningMethods {
  async injectPlanContext() {
    const plan = serializePlanState(this.planState);
    const content = buildPlanTurnInjection(plan);
    await this.session.sendCustomMessage({
      customType: 'approx-plan-context',
      content,
      display: false,
      details: { plan },
    }, { deliverAs: 'nextTurn' });
  }

  setMode(mode, { source = 'user', reason = '' } = {}) {
    applyPlanOperation(this.planState, { action: 'mode', mode, source });
    const plan = serializePlanState(this.planState);
    if (source !== 'tool') this.persistPlanSnapshot(plan);
    this.emit({ type: 'plan_update', plan, source, reason });
    return plan;
  }

  updatePlan(input = {}) {
    const source = input.source || 'tool';
    applyPlanOperation(this.planState, { ...input, source });
    const plan = serializePlanState(this.planState);
    // Tool results already persist their plan details through Pi. Host-side edits
    // need an explicit branch entry so they also survive a restart before the
    // next model turn, without inserting entries mid-stream during tool calls.
    if (source !== 'tool') this.persistPlanSnapshot(plan);
    this.emit({ type: 'plan_update', plan, source });
    if (source === 'user') this.queueLivePlanRevision();
    return plan;
  }

  queueLivePlanRevision() {
    const session = this.session;
    const active = !!session && (session.isStreaming || session.isIdle === false);
    if (!active && !this.planRevisionTask) return false;
    this.planRevisionPending = true;
    if (this.planRevisionTask) return true;
    this.planRevisionTask = this.runLivePlanRevisionLoop()
      .catch((error) => this.emit({ type: 'status', kind: 'warn', text: `Plan restart failed: ${formatError(error)}` }))
      .finally(() => { this.planRevisionTask = null; });
    return true;
  }

  async runLivePlanRevisionLoop() {
    while (this.planRevisionPending) {
      this.planRevisionPending = false;
      const session = this.session;
      if (!session) return;
      if (session.isStreaming) await session.abort();
      if (session.isIdle === false) await session.waitForIdle();
      await Promise.resolve();
      if (this.session !== session) return;
      if (this.planRevisionPending) continue;
      const plan = serializePlanState(this.planState);
      await session.sendCustomMessage({
        customType: 'approx-plan-live-revision',
        content: 'The user changed the active plan while you were working. Discard stale execution assumptions, read the latest plan snapshot below, and continue from it now. Keep Todo status current as you proceed.',
        display: false,
        details: { plan },
      }, { triggerTurn: true });
    }
  }

  persistPlanSnapshot(plan = serializePlanState(this.planState)) {
    const manager = this.session?.sessionManager;
    if (!manager?.appendCustomEntry) return false;
    manager.appendCustomEntry('approx-plan-state', { plan });
    return true;
  }

  restorePlanFromCurrentBranch(reason = 'branch changed') {
    const branch = this.session?.sessionManager?.getBranch?.() ?? [];
    this.planState = restorePlanState(branch, createPlanState());
    const plan = serializePlanState(this.planState);
    this.emit({ type: 'plan_update', plan, source: 'session', reason });
    return plan;
  }

  setAgentMode(mode, reason = '') {
    return this.setMode(mode, { source: 'tool', reason }).mode;
  }

  applyPlanTool(input = {}) {
    const mapped = {
      ...input,
      proposal: input.proposal ?? input.approach,
      source: 'tool',
    };
    if (mapped.action === 'finish') {
      mapped.action = 'replace';
      mapped.mode = 'go';
      mapped.approval = 'approved';
      mapped.todos = this.planState.todos.map((todo) => ({ ...todo, status: 'completed' }));
      mapped.intent = this.planState.intent;
      mapped.proposal = this.planState.proposal;
      mapped.notes = input.notes ?? this.planState.notes;
    }
    const plan = this.updatePlan(mapped);
    if (input.action === 'finish') this.setMode('go', { source: 'tool', reason: 'plan complete' });
    const progress = plan.todos.filter((todo) => todo.status === 'completed').length;
    return {
      state: { plan },
      message: input.action === 'propose' || input.action === 'replace'
        ? 'Plan published. Wait for explicit user approval before implementation.'
        : `Plan updated: ${progress}/${plan.todos.length} todos completed.`,
    };
  }

  requestQuestions(toolCallId, questions, signal, meta = {}) {
    const requestId = `questions-${++this.questionSeq}-${String(toolCallId || 'tool')}`;
    return new Promise((resolveQuestion) => {
      const finish = (result) => {
        if (!this.pendingQuestions.has(requestId)) return;
        this.pendingQuestions.delete(requestId);
        resolveQuestion(result);
      };
      const abort = () => finish({ requestId, cancelled: true, reason: 'interrupted', answers: [], values: {} });
      this.pendingQuestions.set(requestId, { finish, abort });
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      this.emit({
        type: 'questionnaire',
        request: {
          id: requestId,
          title: String(meta.title || 'A FEW SHARP QUESTIONS'),
          intro: String(meta.intro || 'Answer together; Approx will fold the result back into the active turn.'),
          questions,
        },
      });
    });
  }

  async approvePlan(snapshot) {
    this.planState = hydratePlanState(snapshot, this.planState);
    applyPlanOperation(this.planState, {
      action: 'set_approval', approval: 'approved', source: 'user',
    });
    applyPlanOperation(this.planState, { action: 'mode', mode: 'go', source: 'user' });
    const plan = serializePlanState(this.planState);
    this.persistPlanSnapshot(plan);
    this.emit({ type: 'plan_update', plan, source: 'user', reason: 'approved' });
    if (!this.session || this.session.isStreaming) return plan;
    await this.session.sendCustomMessage({
      customType: 'approx-plan-approved',
      content: 'The user approved the displayed plan. Enter Go mode now and execute it to completion, updating the Todo list truthfully as work advances.',
      display: false,
      details: { plan },
    }, { triggerTurn: true });
    return plan;
  }

  async rejectPlan(snapshot, feedback = '') {
    const previousPlan = serializePlanState(this.planState);
    this.planState = hydratePlanState(snapshot, this.planState);
    applyPlanOperation(this.planState, {
      action: 'set_approval', approval: 'rejected', source: 'user',
    });
    applyPlanOperation(this.planState, { action: 'mode', mode: 'plan', source: 'user' });
    const plan = serializePlanState(this.planState);
    const revisionFeedback = String(feedback ?? '').trim();
    this.persistPlanSnapshot(plan);
    this.emit({ type: 'plan_update', plan, source: 'user', reason: 'revision requested' });

    const session = this.session;
    if (!session) return plan;
    const message = {
      customType: 'approx-plan-revision-requested',
      content: [
        'The user rejected the displayed plan and requested a revision.',
        revisionFeedback ? `Revision feedback:\n${revisionFeedback}` : 'No additional revision feedback was provided.',
        'Stay in Plan mode. Rework the proposal and Todo list around this feedback, publish the revised plan with update_plan action="propose", then stop and wait for explicit approval.',
      ].join('\n\n'),
      display: false,
      details: { plan, feedback: revisionFeedback },
    };

    try {
      if (session.isStreaming) {
        await session.sendCustomMessage(message, { deliverAs: 'followUp' });
        return plan;
      }
      if (session.isIdle === false) {
        await session.waitForIdle();
        if (this.session !== session) return plan;
      }
      if (session.isStreaming) {
        await session.sendCustomMessage(message, { deliverAs: 'followUp' });
      } else {
        await session.sendCustomMessage(message, { triggerTurn: true });
      }
    } catch (error) {
      this.planState = hydratePlanState(previousPlan, this.planState);
      const restored = serializePlanState(this.planState);
      this.persistPlanSnapshot(restored);
      this.emit({ type: 'plan_update', plan: restored, source: 'system', reason: 'revision request failed' });
      throw error;
    }
    return plan;
  }

}
