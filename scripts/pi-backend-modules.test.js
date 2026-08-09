import assert from 'node:assert/strict';
import { PiBackend } from '../src/backends/pi.js';
import { FILE_MENTION_INSTRUCTION } from '../src/backends/pi/instructions.js';

const restoredPlan = {
  mode: 'plan',
  intent: 'Restore the persisted plan during startup',
  proposal: 'Exercise the modular openSession path',
  todos: [{ id: 'startup', text: 'Open the session', status: 'in_progress' }],
  approval: 'approved',
};

const sessionManager = {
  getBranch() {
    return [{ type: 'custom', data: { plan: restoredPlan } }];
  },
};

let disposed = false;
const session = {
  model: {
    provider: 'fixture', id: 'fixture-model', name: 'Fixture Model', contextWindow: 128_000,
  },
  modelRuntime: {
    async getAvailable() {
      return [session.model];
    },
  },
  settingsManager: {
    getCompactionSettings() {
      return { enabled: true, reserveTokens: 16_000, keepRecentTokens: 20_000 };
    },
  },
  thinkingLevel: 'high',
  sessionId: 'fixture-session',
  sessionFile: 'fixture-session.jsonl',
  getAvailableThinkingLevels() {
    return ['low', 'high'];
  },
  getUserMessagesForForking() {
    return [];
  },
  getContextUsage() {
    return { tokens: 1234, contextWindow: 128_000, percent: 0.96 };
  },
  subscribe(listener) {
    assert.equal(typeof listener, 'function');
    return () => {};
  },
  dispose() {
    disposed = true;
  },
};

const backend = new PiBackend({ cwd: process.cwd() });
assert.match(FILE_MENTION_INSTRUCTION, /@path/);
assert.match(FILE_MENTION_INSTRUCTION, /use read/);
assert.match(FILE_MENTION_INSTRUCTION, /visible replies/);
assert.match(FILE_MENTION_INSTRUCTION, /demonstrate/);
assert.match(FILE_MENTION_INSTRUCTION, /real project file/);
assert.match(FILE_MENTION_INSTRUCTION, /never use a placeholder/);
const events = [];
backend.subscribe((event) => events.push(event));
backend.modelRuntime = {};
backend.resourceLoader = null;

let factoryOptions;
const opened = await backend.openSession({
  sessionManager,
  sessionFactory: async (options) => {
    factoryOptions = options;
    return { session, modelFallbackMessage: '' };
  },
});

assert.equal(opened, session);
assert.equal(factoryOptions.sessionManager, sessionManager);
assert.equal(factoryOptions.cwd, process.cwd());
assert.equal(backend.planState.intent, restoredPlan.intent);
assert.equal(backend.planState.todos[0].id, 'startup');
assert.equal(backend.started, true);
assert.equal(events.find((event) => event.type === 'ready')?.plan.intent, restoredPlan.intent);
assert.equal(events.find((event) => event.type === 'context')?.tokens, 1234);

backend.dispose();
assert.equal(disposed, true);

const transactional = new PiBackend({ cwd: process.cwd() });
const approdeEvents = [];
transactional.subscribe((event) => {
  if (event.type === 'approde') approdeEvents.push(event);
});
let resourceReloads = 0;
let sessionReloads = 0;
transactional.resourceLoader = {
  async reload() { resourceReloads++; },
};
transactional.session = {
  async reload() {
    sessionReloads++;
    if (sessionReloads === 1) throw new Error('fixture session reload failed');
  },
};

await assert.rejects(
  transactional.applyApprodeSelection({ disabledSkills: ['fixture-skill'], rework: false }),
  /fixture session reload failed/,
);
assert.deepEqual(transactional.serializeApprode(), {
  disabledSkills: [], disabledPrompts: [], activePreset: '',
});
assert.equal(resourceReloads, 2);
assert.equal(sessionReloads, 2);
assert.equal(approdeEvents.length, 0);

await transactional.applyApprodeFromModel({ disableSkills: ['fixture-skill'] });
assert.deepEqual(transactional.serializeApprode().disabledSkills, ['fixture-skill']);
assert.equal(approdeEvents.at(-1)?.reason, 'model');

const transitions = new PiBackend({ cwd: process.cwd() });
let waitedForIdle = 0;
let disposedSessions = 0;
const transitionModel = { provider: 'fixture', id: 'transition-model' };
const oldSession = {
  sessionFile: 'old-session.jsonl',
  model: transitionModel,
  thinkingLevel: 'medium',
  isStreaming: false,
  isIdle: false,
  async waitForIdle() { waitedForIdle++; },
  dispose() { disposedSessions++; },
};
transitions.session = oldSession;
const switchAttempts = [];
transitions.openSession = async (options = {}) => {
  switchAttempts.push(options);
  if (options.sessionPath === 'broken-session.jsonl') {
    transitions.session = { dispose() { disposedSessions++; } };
    throw new Error('fixture session open failed');
  }
  const recovered = { ...oldSession, isIdle: true };
  transitions.session = recovered;
  return recovered;
};
await assert.rejects(transitions.switchSession('broken-session.jsonl'), /fixture session open failed/);
assert.equal(waitedForIdle, 1);
assert.equal(disposedSessions, 2);
assert.equal(transitions.session?.sessionFile, 'old-session.jsonl');
assert.equal(switchAttempts.at(-1)?.sessionPath, 'old-session.jsonl');
assert.equal(switchAttempts.at(-1)?.model, transitionModel);

const newAttempts = [];
transitions.openSession = async (options = {}) => {
  newAttempts.push(options);
  if (!options.sessionPath) {
    transitions.session = { dispose() { disposedSessions++; } };
    throw new Error('fixture conversation create failed');
  }
  const recovered = { ...oldSession, isIdle: true };
  transitions.session = recovered;
  return recovered;
};
await assert.rejects(transitions.newConversation(), /fixture conversation create failed/);
assert.equal(transitions.session?.sessionFile, 'old-session.jsonl');
assert.equal(newAttempts.at(-1)?.sessionPath, 'old-session.jsonl');

const settledBackend = new PiBackend({ cwd: process.cwd() });
const settledEvents = [];
settledBackend.subscribe((event) => {
  if (event.type === 'settled') settledEvents.push(event);
});
settledBackend.emitContext = () => {};
settledBackend.injectPlanContext = async () => {};
settledBackend.session = {
  async prompt() {
    settledBackend.onPiEvent({ type: 'agent_settled' });
  },
};
await settledBackend.prompt('fixture prompt');
assert.equal(settledEvents.length, 1);

settledEvents.length = 0;
settledBackend.session.prompt = async () => {};
await settledBackend.prompt('provider without agent_settled');
assert.equal(settledEvents.length, 1);

console.log('pi backend module startup test passed');
