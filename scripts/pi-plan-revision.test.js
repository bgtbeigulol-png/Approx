import assert from 'node:assert/strict';
import { PiBackend } from '../src/backends/pi.js';

const snapshot = {
  mode: 'plan',
  intent: 'Ship the feature',
  proposal: 'Use the first approach',
  todos: [{ id: 'todo-1', text: 'Implement it', status: 'pending' }],
  approval: 'pending',
};

function fakeSession({ streaming = false, idle = true, wait } = {}) {
  const calls = [];
  return {
    isStreaming: streaming,
    isIdle: idle,
    calls,
    async waitForIdle() {
      await wait?.(this);
      this.isIdle = true;
    },
    async sendCustomMessage(message, options) {
      calls.push({ message, options });
    },
  };
}

{
  const backend = new PiBackend();
  const events = [];
  backend.subscribe((event) => events.push(event));
  backend.session = fakeSession();

  const plan = await backend.rejectPlan(snapshot, 'Keep the public API smaller.');

  assert.equal(plan.mode, 'plan');
  assert.equal(plan.approval, 'rejected');
  assert.equal(events.at(-1)?.reason, 'revision requested');
  assert.equal(backend.session.calls.length, 1);
  assert.deepEqual(backend.session.calls[0].options, { triggerTurn: true });
  assert.equal(backend.session.calls[0].message.customType, 'approx-plan-revision-requested');
  assert.match(backend.session.calls[0].message.content, /Keep the public API smaller\./);
  assert.equal(backend.session.calls[0].message.details.feedback, 'Keep the public API smaller.');
}

{
  const backend = new PiBackend();
  backend.session = fakeSession({ streaming: true, idle: false });

  await backend.rejectPlan(snapshot, 'Split the migration into two steps.');

  assert.equal(backend.session.calls.length, 1);
  assert.deepEqual(backend.session.calls[0].options, { deliverAs: 'followUp' });
}

{
  const backend = new PiBackend();
  let waited = false;
  backend.session = fakeSession({
    idle: false,
    wait: async () => { waited = true; },
  });

  await backend.rejectPlan(snapshot, 'Re-check the failure mode.');

  assert.equal(waited, true);
  assert.equal(backend.session.calls.length, 1);
  assert.deepEqual(backend.session.calls[0].options, { triggerTurn: true });
}

{
  const backend = new PiBackend();
  const events = [];
  backend.subscribe((event) => events.push(event));
  backend.planState = {
    ...backend.planState,
    mode: 'plan',
    approval: 'pending',
    intent: 'Keep the previous proposal retryable',
  };
  backend.session = {
    isStreaming: false,
    isIdle: true,
    sessionManager: { appendCustomEntry() {} },
    async sendCustomMessage() { throw new Error('provider disconnected'); },
  };

  await assert.rejects(
    backend.rejectPlan(snapshot, 'Try a different route.'),
    /provider disconnected/,
  );

  assert.equal(backend.planState.approval, 'pending');
  assert.equal(backend.planState.intent, 'Keep the previous proposal retryable');
  assert.equal(events.at(-1)?.reason, 'revision request failed');
}

console.log('pi plan revision tests passed');
