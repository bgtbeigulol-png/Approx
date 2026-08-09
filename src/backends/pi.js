// Pi backend composition root. Domain behavior lives in ./pi/*.js.

import { createPlanState } from '../plan.js';
import { PiEventMethods } from './pi/events.js';
import { PiHistoryMethods } from './pi/history.js';
import { PiPlanningMethods } from './pi/planning.js';
import { PiResourceMethods } from './pi/resources.js';
import { PiSessionMethods } from './pi/session.js';
export class PiBackend {
  constructor({ cwd = process.cwd(), continueSession = false } = {}) {
    this.cwd = cwd;
    this.continueSession = continueSession;
    this.session = null;
    this.listeners = new Set();
    this.unsubscribePi = null;
    this.assistantOpen = false;
    this.assistantText = '';
    this.toolTitles = [];
    this.pendingToolTitles = [];
    this.pendingToolGroupTitle = '';
    this.started = false;
    this.modelRuntime = null;
    this.resourceLoader = null;
    this.toolMutations = new Map();
    this.mutationJournal = new Map();
    this.knownUserEntries = new Set();
    this.autoCompactThreshold = null;
    this.baseCompactionSettings = null;
    this.manualCompaction = null;
    this.planState = createPlanState();
    this.pendingQuestions = new Map();
    this.questionSeq = 0;
    this.setupPromise = null;
    this.planRevisionTask = null;
    this.planRevisionPending = false;
    // Approde hot-swap state. The loader override callbacks (installed in
    // loadResourceLoader) close over this object and read it fresh on every
    // loader.reload(), so mutating the sets here and reloading is the swap.
    this.approdeFilter = {
      disabledSkills: new Set(),
      disabledPrompts: new Set(),
      activePreset: '',
    };
    this.approdeCatalog = { skills: [], prompts: [] };
    this.approdeRevisionTask = null;
    this.approdeRevisionPending = false;
    this.approdeApplyTask = null;
    this.settledEventSeq = 0;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A view listener must not take the agent runtime down.
      }
    }
  }

}

for (const behavior of [
  PiResourceMethods,
  PiPlanningMethods,
  PiSessionMethods,
  PiHistoryMethods,
  PiEventMethods,
]) {
  for (const name of Object.getOwnPropertyNames(behavior.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(
      PiBackend.prototype,
      name,
      Object.getOwnPropertyDescriptor(behavior.prototype, name),
    );
  }
}
