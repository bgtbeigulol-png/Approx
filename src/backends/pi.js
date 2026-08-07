// Live backend — adapts AgentSession events to Approx's small UI-facing protocol.
// Approx owns the terminal; the embedded runtime owns models, tools, sessions,
// skills, extensions, context discovery, compaction, and retries.

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  VERSION as PI_VERSION,
} from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createApproxHostTools } from '../pi-host-tools.js';
import {
  applyPlanOperation, buildPlanTurnInjection, createPlanState, hydratePlanState, serializePlanState,
} from '../plan.js';

const TOOL_TITLE_INSTRUCTION = `Name tool work for the host UI without hiding the progress narrative. Every assistant message that ends in tool use MUST begin with one concise plain-text status sentence explaining the current phase or why the next tools are needed. This sentence is shown to the user as a Note, so never emit headings alone and never put the status only in thinking/reasoning. Then, before each substantial individual tool call, emit one standalone Markdown heading in VISIBLE assistant text content, exactly as "### <short action title>". When three or more related calls share one task, the FIRST visible heading MUST instead be exactly "### Tool Calls: <short batch title>"; this is the large parent-card title, never the first command's title. Then name individual calls with ordinary "### <short action title>" headings, in call order. Keep status sentences and titles concrete and brief. The host removes only these headings from conversation text; the status sentence remains visible.`;
const APPROX_CONTROL_INSTRUCTION = `Approx has two host modes. Go is the default execution mode. Plan is a deliberate design phase for large, ambiguous, multi-part, or high-consequence work. Use set_mode to enter Plan instead of only saying that you will plan. In Plan, investigate the user's actual intent, constraints, alternatives, failure modes, and non-obvious opportunities. Use ask_questions whenever material information is missing, with at most five structured questions. Publish the execution design through update_plan action="propose", including a concrete Todo list and hidden notes, then stop and wait for explicit approval. Do not mutate the project before approval. In Go, keep update_plan current as work starts, completes, or changes. The visible Todo strip must remain truthful, and finish means every required item is actually complete.`;

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

  async start() {
    if (this.started) return this;
    this.modelRuntime = await ModelRuntime.create();
    this.resourceLoader = await this.loadResourceLoader(this.cwd);
    await this.openSession({ continueSession: this.continueSession });
    return this;
  }

  async loadResourceLoader(cwd) {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      appendSystemPrompt: [TOOL_TITLE_INSTRUCTION, APPROX_CONTROL_INSTRUCTION],
    });
    await loader.reload();
    return loader;
  }

  async openSession({ continueSession = false, sessionPath, model, effort } = {}) {
    const sessionManager = sessionPath
      ? SessionManager.open(sessionPath, undefined, this.cwd)
      : continueSession
        ? SessionManager.continueRecent(this.cwd)
        : SessionManager.create(this.cwd);

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.cwd,
      sessionManager,
      modelRuntime: this.modelRuntime,
      resourceLoader: this.resourceLoader,
      customTools: createApproxHostTools(this),
      ...(model ? { model } : {}),
      ...(effort ? { thinkingLevel: effort } : {}),
    });

    this.session = session;
    this.planState = restorePlanState(sessionManager.getBranch(), this.planState);
    this.baseCompactionSettings = session.settingsManager.getCompactionSettings();
    this.applyAutoCompactThreshold();
    this.knownUserEntries = new Set(session.getUserMessagesForForking().map((entry) => entry.entryId));
    this.unsubscribePi = session.subscribe((event) => this.onPiEvent(event));
    this.started = true;

    const models = (await session.modelRuntime.getAvailable()).map(normalizeModel);
    this.emit({
      type: 'ready',
      runtime: `Approx ${PI_VERSION}`,
      model: normalizeModel(session.model),
      models,
      effort: session.thinkingLevel,
      effortOptions: session.getAvailableThinkingLevels(),
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      cwd: this.cwd,
      continued: continueSession,
      plan: serializePlanState(this.planState),
    });

    const history = sessionTranscript(sessionManager.getBranch());
    if (history.length) this.emit({ type: 'history', messages: history, sessionFile: session.sessionFile });

    if (modelFallbackMessage) {
      this.emit({ type: 'status', kind: 'warn', text: modelFallbackMessage });
    }
    if (!models.length) {
      this.emit({
        type: 'status',
        kind: 'warn',
        text: 'Approx found no Pi model · opening the connection setup',
      });
      this.emit({ type: 'setup_required', text: 'No Pi model is configured. Approx will guide setup now.' });
    }
    this.emitContext();
    return session;
  }

  async prompt(text) {
    this.requireSession();
    if (shouldAutoPlan(text, this.planState)) {
      applyPlanOperation(this.planState, {
        action: 'mode', mode: 'plan', source: 'auto',
      });
      this.emit({
        type: 'plan_update', plan: serializePlanState(this.planState),
        reason: 'large task detected', source: 'auto',
      });
    }
    this.emit({ type: 'busy' });
    try {
      await this.injectPlanContext();
      await this.session.prompt(String(text), { source: 'interactive' });
    } catch (error) {
      if (!isAbortError(error)) this.emit({ type: 'error', error: formatError(error) });
      throw error;
    } finally {
      this.emitContext();
      this.emit({ type: 'settled' });
    }
  }

  /** Pi can remain active between short WORK notes even when the host has not
   * opened a visible turn envelope (for example, an approved Plan continuation). */
  isBusy() {
    return !!this.session && !this.session.isIdle;
  }

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
    return plan;
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

  async startSetup() {
    if (this.setupPromise) return this.setupPromise;
    this.setupPromise = this.runSetup().finally(() => { this.setupPromise = null; });
    return this.setupPromise;
  }

  async runSetup() {
    const providers = this.modelRuntime.getProviders()
      .map((provider) => ({
        id: String(provider.id),
        name: String(provider.name || provider.id),
        auth: Object.keys(provider.auth || {}),
      }))
      .filter((provider) => provider.auth.length);
    if (!providers.length) {
      this.emit({ type: 'status', kind: 'warn', text: 'Pi has no configurable providers.' });
      return false;
    }
    const providerResult = await this.requestQuestions('setup-provider', [{
      id: 'provider', type: 'single', required: true,
      prompt: 'Connect a model provider',
      description: 'Approx handles the setup; Pi keeps the provider and credentials.',
      options: providers.map((provider) => ({ value: provider.id, label: provider.name })),
    }], undefined, { title: 'CONNECT A MODEL', intro: 'Choose a provider to connect through Pi.' });
    if (providerResult.cancelled) {
      this.emit({ type: 'status', kind: 'info', text: 'Pi setup cancelled.' });
      return false;
    }
    const provider = providers.find((item) => item.id === providerResult.values.provider);
    if (!provider) return false;
    let authType = provider.auth.includes('apiKey') ? 'api_key' : 'oauth';
    if (provider.auth.includes('apiKey') && provider.auth.includes('oauth')) {
      const authResult = await this.requestQuestions('setup-auth-type', [{
        id: 'authType', type: 'single', required: true,
        prompt: `Choose how to connect ${provider.name}`,
        options: [
          { value: 'api_key', label: 'API key' },
          { value: 'oauth', label: 'Browser / subscription login' },
        ],
      }], undefined, { title: 'CHOOSE SIGN-IN', intro: 'Approx will keep the visual flow; Pi handles the credential exchange.' });
      if (authResult.cancelled) return false;
      authType = authResult.values.authType === 'oauth' ? 'oauth' : 'api_key';
    }
    const interaction = {
      prompt: async (prompt) => {
        const type = prompt.type === 'secret' ? 'secret' : prompt.type === 'select' ? 'single' : 'text';
        const question = {
          id: `setup-${this.questionSeq + 1}`,
          type,
          prompt: String(prompt.message || 'Enter connection details'),
          description: 'Pi will store credentials securely after this step.',
          placeholder: prompt.placeholder,
          required: true,
          options: type === 'single' ? (prompt.options || []).map((option) => ({
            value: String(option.id), label: String(option.label), description: option.description,
          })) : undefined,
        };
        const result = await this.requestQuestions('setup-auth', [question], prompt.signal, {
          title: `CONNECT ${provider.name.toUpperCase()}`,
          intro: 'Approx owns this screen. Pi owns the authentication and storage.',
        });
        if (result.cancelled) throw new Error('Pi setup cancelled');
        return String(result.values[question.id] ?? '');
      },
      notify: (event) => {
        const text = event?.message || (event?.url ? `Open ${event.url}` : 'Pi authentication update');
        this.emit({ type: 'status', kind: 'info', text: String(text) });
      },
    };
    try {
      await this.modelRuntime.login(provider.id, authType, interaction);
      await this.modelRuntime.refresh();
      const models = await this.modelRuntime.getAvailable();
      if (!models.length) throw new Error('Pi login succeeded but no usable models were found');
      const model = models[0];
      await this.session.setModel(this.session.modelRuntime.getModel(model.provider, model.id));
      this.emit({ type: 'setup_complete', model: normalizeModel(this.session.model), models: models.map(normalizeModel) });
      return true;
    } catch (error) {
      this.emit({ type: 'status', kind: 'warn', text: `Pi setup failed: ${formatError(error)}` });
      return false;
    }
  }

  resolveQuestionnaire(requestId, result) {
    const pending = this.pendingQuestions.get(String(requestId));
    if (!pending) return false;
    pending.finish(result);
    return true;
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

  async abort() {
    this.requireSession();
    // compact() first awaits the ordinary agent abort before installing Pi's
    // dedicated compaction controller. Yield once so an immediate escape press
    // cannot slip through that narrow hand-off window.
    if (this.manualCompaction && !this.session.isCompacting) await Promise.resolve();
    if (this.session.isCompacting) this.session.abortCompaction();
    await this.session.abort();
    this.emit({ type: 'settled' });
  }

  async compact(customInstructions = '') {
    this.requireSession();
    const instructions = String(customInstructions ?? '').trim();
    const request = this.session.compact(instructions || undefined);
    this.manualCompaction = request;
    try {
      const result = await request;
      this.emitContext();
      return result;
    } finally {
      if (this.manualCompaction === request) this.manualCompaction = null;
    }
  }

  async listSessions() {
    const items = await SessionManager.list(this.cwd);
    const current = this.session?.sessionFile;
    return items
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .map((item) => ({
        path: item.path,
        id: item.id,
        title: item.name || oneLine(item.firstMessage) || 'Untitled conversation',
        created: item.created.toISOString(),
        modified: item.modified.toISOString(),
        modifiedLabel: relativeDate(item.modified),
        messageCount: item.messageCount,
        current: !!current && resolve(item.path).toLowerCase() === resolve(current).toLowerCase(),
      }));
  }

  async switchSession(path) {
    this.requireSession();
    if (this.session.isStreaming) {
      await this.session.abort();
      await this.session.waitForIdle();
    }
    this.unsubscribePi?.();
    this.unsubscribePi = null;
    this.session.dispose();
    this.session = null;
    this.resetAdapterState();
    this.planState = createPlanState();
    return this.openSession({ sessionPath: String(path) });
  }

  async changeDirectory(nextCwd) {
    this.requireSession();
    const canonical = await realpath(resolve(String(nextCwd)));
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error(`Not a directory: ${canonical}`);
    if (samePath(canonical, this.cwd)) return canonical;

    const previous = {
      cwd: this.cwd,
      loader: this.resourceLoader,
      sessionFile: this.session.sessionFile,
      model: this.session.model,
      effort: this.session.thinkingLevel,
      plan: serializePlanState(this.planState),
    };
    const nextLoader = await this.loadResourceLoader(canonical);
    if (this.session.isStreaming) {
      await this.session.abort();
      await this.session.waitForIdle();
    }

    this.unsubscribePi?.();
    this.unsubscribePi = null;
    this.session.dispose();
    this.session = null;
    this.resetAdapterState();
    this.cwd = canonical;
    this.resourceLoader = nextLoader;
    this.planState = createPlanState();

    try {
      process.chdir(canonical);
      const session = await this.openSession({ model: previous.model, effort: previous.effort });
      this.emit({
        type: 'workspace_changed', cwd: canonical,
        sessionId: session.sessionId, sessionFile: session.sessionFile,
        plan: serializePlanState(this.planState),
      });
      return canonical;
    } catch (error) {
      this.cwd = previous.cwd;
      this.resourceLoader = previous.loader;
      this.planState = hydratePlanState(previous.plan);
      process.chdir(previous.cwd);
      try {
        await this.openSession({
          sessionPath: previous.sessionFile,
          model: previous.model,
          effort: previous.effort,
        });
      } catch {
        // Preserve the original failure; the next command will report backend state if recovery also failed.
      }
      throw error;
    }
  }

  async setModel(model) {
    this.requireSession();
    const next = this.session.modelRuntime.getModel(model.provider, model.id);
    if (!next) throw new Error(`Approx model not found: ${model.provider}/${model.id}`);
    await this.session.setModel(next);
    this.applyAutoCompactThreshold();
    this.emit({
      type: 'model',
      model: normalizeModel(this.session.model),
      effort: this.session.thinkingLevel,
      effortOptions: this.session.getAvailableThinkingLevels(),
    });
  }

  async cycleModel() {
    this.requireSession();
    const result = await this.session.cycleModel();
    if (!result) return null;
    this.applyAutoCompactThreshold();
    const model = normalizeModel(this.session.model);
    this.emit({
      type: 'model',
      model,
      effort: this.session.thinkingLevel,
      effortOptions: this.session.getAvailableThinkingLevels(),
    });
    return model;
  }

  setEffort(level) {
    this.requireSession();
    this.session.setThinkingLevel(level);
    const effort = this.session.thinkingLevel;
    this.emit({ type: 'effort', effort });
    return effort;
  }

  cycleEffort() {
    this.requireSession();
    const effort = this.session.cycleThinkingLevel();
    if (effort) this.emit({ type: 'effort', effort });
    return effort;
  }

  setAutoCompactThreshold({ mode = 'percent', percent = 80, tokens = 32768 } = {}) {
    this.autoCompactThreshold = {
      mode: mode === 'tokens' ? 'tokens' : 'percent',
      percent: Math.max(10, Math.min(100, Math.round(Number(percent) / 10) * 10 || 80)),
      tokens: Math.max(32768, Math.round(Number(tokens)) || 32768),
    };
    return this.applyAutoCompactThreshold();
  }

  applyAutoCompactThreshold() {
    if (!this.session || !this.autoCompactThreshold) return null;
    const contextWindow = Number(this.session.model?.contextWindow);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
    const configured = this.autoCompactThreshold.mode === 'tokens'
      ? this.autoCompactThreshold.tokens
      : Math.round(contextWindow * this.autoCompactThreshold.percent / 100);
    const thresholdTokens = Math.max(1, Math.min(contextWindow, configured));
    const reserveTokens = Math.max(0, contextWindow - thresholdTokens);
    const base = this.baseCompactionSettings ?? this.session.settingsManager.getCompactionSettings();
    // A low percentage can sit below Pi's 20K keep-recent default. Scale that
    // budget down so the native compactor has old material to summarize.
    const keepRecentTokens = Math.min(
      base.keepRecentTokens,
      Math.max(1024, Math.floor(thresholdTokens * 0.5)),
    );
    this.session.settingsManager.applyOverrides({
      compaction: { enabled: true, reserveTokens, keepRecentTokens },
    });
    return {
      ...this.autoCompactThreshold,
      contextWindow,
      thresholdTokens,
      reserveTokens,
      keepRecentTokens,
    };
  }

  async resetContext() {
    this.requireSession();
    if (this.session.isStreaming) {
      await this.session.abort();
      await this.session.waitForIdle();
    }
    const manager = this.session.sessionManager;
    manager.resetLeaf?.();
    if (typeof manager.buildSessionContext === 'function' && this.session.agent?.state) {
      this.session.agent.state.messages = manager.buildSessionContext().messages;
    }
    this.resetAdapterState();
    this.knownUserEntries = new Set(this.session.getUserMessagesForForking().map((entry) => entry.entryId));
    this.emit({ type: 'context_reset', sessionId: this.session.sessionId });
    this.emitContext();
    return this.session.sessionId;
  }

  /** Start a separate persisted conversation while preserving runtime choices. */
  async newConversation() {
    this.requireSession();
    if (this.session.isStreaming) {
      await this.session.abort();
      await this.session.waitForIdle();
    }
    const model = this.session.model;
    const effort = this.session.thinkingLevel;
    this.unsubscribePi?.();
    this.unsubscribePi = null;
    this.session.dispose();
    this.session = null;
    this.resetAdapterState();
    this.planState = createPlanState();
    const session = await this.openSession({ model, effort });
    this.emit({ type: 'conversation_new', sessionId: session.sessionId, sessionFile: session.sessionFile });
    return session.sessionId;
  }

  dispose() {
    for (const pending of this.pendingQuestions.values()) pending.finish({
      cancelled: true, reason: 'session closed', answers: [], values: {},
    });
    this.pendingQuestions.clear();
    this.unsubscribePi?.();
    this.unsubscribePi = null;
    this.session?.dispose();
    this.session = null;
    this.manualCompaction = null;
    this.started = false;
  }

  resetAdapterState() {
    this.assistantOpen = false;
    this.assistantText = '';
    this.toolTitles = [];
    this.pendingToolTitles = [];
    this.pendingToolGroupTitle = '';
    this.toolMutations.clear();
    this.mutationJournal.clear();
    this.knownUserEntries.clear();
    for (const pending of this.pendingQuestions.values()) pending.finish({
      cancelled: true, reason: 'session changed', answers: [], values: {},
    });
    this.pendingQuestions.clear();
  }

  requireSession() {
    if (!this.session) throw new Error('Approx backend has not started');
  }

  onPiEvent(event) {
    switch (event.type) {
      case 'agent_start':
        this.assistantText = '';
        this.toolTitles = [];
        this.pendingToolTitles = [];
        this.pendingToolGroupTitle = '';
        this.emit({ type: 'busy' });
        break;
      case 'agent_settled':
        this.emitContext();
        this.emit({ type: 'settled' });
        break;
      case 'message_update':
        this.onAssistantUpdate(event.assistantMessageEvent);
        break;
      case 'message_end':
        if (event.message?.role === 'assistant') this.endAssistant(event.message);
        if (event.message?.role === 'user') {
          const text = messageText(event.message);
          // AgentSession persists the message immediately after subscriber delivery.
          // A microtask observes the completed append and can attach its stable tree id.
          queueMicrotask(() => this.emitUserEntry(text));
        }
        break;
      case 'tool_execution_start':
        {
        const mutation = captureMutation(this.cwd, event.toolName, event.args);
        if (mutation) {
          mutation.callId = String(event.toolCallId);
          this.toolMutations.set(String(event.toolCallId), mutation);
        }
        const inlineTitles = modelToolTitles(this.assistantText);
        if (inlineTitles.length) this.pendingToolTitles.push(...unconsumedTitles(inlineTitles, this.toolTitles, this.pendingToolTitles));
        const modelTitle = this.pendingToolTitles.shift() || '';
        const groupTitle = modelToolGroupTitle(this.assistantText) || this.pendingToolGroupTitle;
        const groupHeading = groupTitle ? `Tool Calls: ${groupTitle}` : '';
        const fallbackTitle = toolTitle(event.toolName, event.args);
        const title = modelTitle || fallbackTitle;
        if (modelTitle) this.toolTitles.push(modelTitle);
        if (groupHeading) this.toolTitles.push(groupHeading);
        this.assistantText = '';
        this.pendingToolGroupTitle = '';
        this.emit({
          type: 'tool_start',
          id: event.toolCallId,
          name: event.toolName,
          title,
          fallbackTitle,
          modelTitle: !!modelTitle,
          groupTitle,
          groupHeading,
          modelGroupTitle: !!groupTitle,
          meta: summarizeArgs(event.args),
          args: event.args,
        });
        break;
        }
      case 'tool_execution_update':
        this.emit({
          type: 'tool_update',
          id: event.toolCallId,
          text: contentText(event.partialResult?.content),
        });
        break;
      case 'tool_execution_end':
        {
        const mutation = finishMutation(this.toolMutations.get(String(event.toolCallId)));
        this.toolMutations.delete(String(event.toolCallId));
        if (mutation) this.mutationJournal.set(String(event.toolCallId), mutation);
        this.emit({
          type: 'tool_end',
          id: event.toolCallId,
          text: contentText(event.result?.content),
          isError: !!event.isError,
          mutation,
        });
        break;
        }
      case 'compaction_start':
        this.emit({
          type: 'compaction_start',
          reason: event.reason,
        });
        break;
      case 'compaction_end':
        this.emit({
          type: 'compaction_end',
          reason: event.reason,
          aborted: !!event.aborted,
          willRetry: !!event.willRetry,
          errorMessage: event.errorMessage || '',
          tokensBefore: event.result?.tokensBefore ?? null,
          estimatedTokensAfter: event.result?.estimatedTokensAfter ?? null,
        });
        this.emitContext();
        break;
      case 'auto_retry_start':
        this.emit({
          type: 'status',
          kind: 'warn',
          text: `Approx retry ${event.attempt}/${event.maxAttempts}`,
        });
        break;
      case 'auto_retry_end':
        if (!event.success) {
          this.emit({ type: 'error', error: event.finalError || 'Approx retry failed' });
        }
        break;
      case 'thinking_level_changed':
        this.emit({ type: 'effort', effort: event.level });
        break;
      default:
        break;
    }
  }

  onAssistantUpdate(update) {
    if (!update) return;
    if (update.type === 'text_start') {
      this.ensureAssistant();
      return;
    }
    if (update.type === 'text_delta') {
      this.ensureAssistant();
      if (update.delta) {
        this.assistantText += update.delta;
        this.emit({ type: 'assistant_delta', delta: update.delta });
      }
      return;
    }
    if (update.type === 'thinking_start') {
      this.emit({ type: 'status', kind: 'info', text: 'Approx is working' });
    }
  }

  ensureAssistant() {
    if (this.assistantOpen) return;
    this.assistantOpen = true;
    this.emit({ type: 'assistant_start' });
  }

  endAssistant(message) {
    const rawText = messageText(message);
    const stopReason = String(message.stopReason ?? '');
    const trailingTitles = message.stopReason === 'toolUse' ? modelToolTitles(rawText) : [];
    const unseenTitles = unconsumedTitles(trailingTitles, this.toolTitles, this.pendingToolTitles);
    if (unseenTitles.length) this.pendingToolTitles.push(...unseenTitles);
    const trailingGroupTitle = message.stopReason === 'toolUse' ? modelToolGroupTitle(rawText) : '';
    if (trailingGroupTitle) this.pendingToolGroupTitle = trailingGroupTitle;
    const titles = [
      ...this.toolTitles,
      ...trailingTitles,
      ...(trailingGroupTitle ? [`Tool Calls: ${trailingGroupTitle}`] : []),
    ];
    const text = stripToolTitleHeadings(rawText, titles);
    // Always publish the structured end marker, even when a naming-only message
    // becomes empty after its heading is consumed. The UI uses stopReason, never
    // model prose, to distinguish intermediate toolUse notes from final delivery.
    if (text || this.assistantOpen) this.ensureAssistant();
    this.emit({ type: 'assistant_end', text, stopReason, final: stopReason.toLowerCase() !== 'tooluse' });
    this.assistantOpen = false;
    this.assistantText = '';
    this.toolTitles = [];

    if (message.stopReason === 'error' && message.errorMessage) {
      this.emit({ type: 'error', error: message.errorMessage });
    }
    if (Number.isFinite(message.usage?.output)) {
      this.emit({ type: 'usage', outputTokens: message.usage.output });
    }
    this.emitContext();
  }

  emitContext() {
    if (!this.session) return;
    const usage = this.session.getContextUsage();
    if (!usage) return;
    this.emit({
      type: 'context',
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent,
    });
  }

  emitUserEntry(text) {
    if (!this.session) return;
    const entries = this.session.getUserMessagesForForking();
    const entry = [...entries].reverse().find((candidate) => !this.knownUserEntries.has(candidate.entryId)
      && candidate.text === text);
    if (!entry) return;
    this.knownUserEntries.add(entry.entryId);
    this.emit({ type: 'user_entry', entryId: entry.entryId, text: entry.text });
  }
}

function restorePlanState(branch, fallback = createPlanState()) {
  for (let index = (branch?.length ?? 0) - 1; index >= 0; index--) {
    const entry = branch[index];
    const message = entry?.message;
    const details = message?.details ?? entry?.details ?? entry?.data;
    const snapshot = details?.plan ?? details?.state?.plan ?? details?.state;
    if (snapshot && typeof snapshot === 'object' && ('mode' in snapshot || 'todos' in snapshot)) {
      return hydratePlanState(snapshot, fallback);
    }
  }
  return hydratePlanState(fallback);
}

function shouldAutoPlan(text, plan) {
  if (plan?.mode === 'plan' || plan?.todos?.length) return false;
  const value = String(text ?? '').trim();
  if (value.length >= 900) return true;
  const signals = [
    /\b(?:architecture|redesign|migration|migrate|large[- ]scale|multi[- ]step|roadmap)\b/i,
    /\b(?:implement|build|refactor|design)\b[\s\S]{0,160}\b(?:system|application|workflow|platform)\b/i,
    /(?:大型|复杂|完整|整体|架构|重构|迁移|方案|多步骤|全流程)/,
  ];
  return value.length >= 280 && signals.some((pattern) => pattern.test(value));
}

function samePath(left, right) {
  const a = resolve(String(left));
  const b = resolve(String(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function mutationPath(cwd, args) {
  if (!args || typeof args !== 'object') return null;
  const raw = args.path ?? args.file_path ?? args.filePath;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

function fileSnapshot(path) {
  if (!existsSync(path)) return { exists: false, data: '' };
  return { exists: true, data: readFileSync(path).toString('base64') };
}

function captureMutation(cwd, name, args) {
  const kind = String(name ?? '').toLowerCase();
  if (kind !== 'write' && kind !== 'edit') return null;
  const path = mutationPath(cwd, args);
  if (!path) return null;
  try {
    return { kind, path, before: fileSnapshot(path), after: null };
  } catch {
    return null;
  }
}

function mergeMutations(primary, extra) {
  const seen = new Set();
  const out = [];
  for (const mutation of [...primary, ...extra]) {
    if (!mutation) continue;
    const key = `${mutation.kind}\0${mutation.path}\0${mutation.before?.data ?? ''}\0${mutation.after?.data ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mutation);
  }
  return out;
}

function finishMutation(mutation) {
  if (!mutation) return null;
  try {
    const after = fileSnapshot(mutation.path);
    if (after.exists === mutation.before.exists && after.data === mutation.before.data) return null;
    return { ...mutation, after };
  } catch {
    return null;
  }
}

function restoreSnapshot(path, snapshot) {
  if (snapshot?.exists) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(snapshot.data, 'base64'));
  } else if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

function restoreMutations(mutations, side) {
  const ordered = side === 'before' ? [...mutations].reverse() : [...mutations];
  for (const mutation of ordered) {
    if (!mutation?.path || !mutation?.[side]) continue;
    restoreSnapshot(mutation.path, mutation[side]);
  }
}

function normalizeModel(model) {
  if (!model) return null;
  return {
    provider: String(model.provider),
    id: String(model.id),
    label: String(model.id || model.name || `${model.provider}/model`),
    name: String(model.name || model.id),
    contextWindow: Number(model.contextWindow) || 0,
  };
}

function messageText(message) {
  return contentText(message?.content);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** Rehydrate the visible branch without injecting any extra messages into context. */
function sessionTranscript(entries) {
  const visible = [];
  const calls = new Map();
  let pendingTitles = [];
  let pendingGroup = '';
  for (const entry of entries ?? []) {
    if (entry?.type !== 'message') continue;
    const message = entry.message ?? {};
    const time = shortTime(entry.timestamp);
    if (message.role === 'user') {
      const text = messageText(message);
      if (text) visible.push({ role: 'user', text, entryId: entry.id, time });
      continue;
    }
    if (message.role === 'assistant') {
      const parts = Array.isArray(message.content) ? message.content : [];
      const toolCalls = parts.filter((part) => part?.type === 'toolCall');
      const raw = messageText(message);
      const namingTurn = toolCalls.length > 0 || message.stopReason === 'toolUse';
      const parsedTitles = namingTurn ? modelToolTitles(raw) : [];
      const availableTitles = [...pendingTitles, ...unconsumedTitles(parsedTitles, [], pendingTitles)];
      const groupTitle = namingTurn ? (modelToolGroupTitle(raw) || pendingGroup) : '';
      const headings = [
        ...availableTitles,
        ...(groupTitle ? [`Tool Calls: ${groupTitle}`] : []),
      ];
      const text = namingTurn ? stripToolTitleHeadings(raw, headings) : raw;
      if (text) visible.push({ role: 'approx', text, time, stopReason: String(message.stopReason ?? '') });
      if (!toolCalls.length && namingTurn) {
        pendingTitles = availableTitles;
        if (groupTitle) pendingGroup = groupTitle;
      }
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const fallbackTitle = toolTitle(call.name, call.arguments);
        const title = availableTitles[i] || '';
        const tool = {
          role: 'tool',
          callId: String(call.id ?? `historic-tool-${visible.length}`),
          name: String(call.name ?? 'tool'),
          title: title || fallbackTitle,
          fallbackTitle,
          modelTitle: !!title,
          groupTitle: i === 0 ? groupTitle : '',
          modelGroupTitle: i === 0 && !!groupTitle,
          meta: summarizeArgs(call.arguments),
          text: '',
          running: false,
          expanded: false,
          time,
        };
        visible.push(tool);
        calls.set(tool.callId, tool);
      }
      if (toolCalls.length) {
        pendingTitles = [];
        pendingGroup = '';
      }
      continue;
    }
    if (message.role === 'toolResult') {
      const id = String(message.toolCallId ?? '');
      let tool = calls.get(id);
      if (!tool) {
        const name = String(message.toolName ?? 'tool');
        const fallbackTitle = toolTitle(name, {});
        tool = {
          role: 'tool', callId: id || `historic-tool-${visible.length}`, name,
          title: fallbackTitle, fallbackTitle, text: '', running: false, expanded: false, time,
        };
        visible.push(tool);
        calls.set(tool.callId, tool);
      }
      tool.text = contentText(message.content);
      tool.isError = !!message.isError;
      tool.meta = tool.isError ? 'error' : (tool.meta || 'done');
    }
  }
  return visible;
}

function summarizeArgs(args) {
  if (args == null) return '';
  let text;
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args);
  } catch {
    text = String(args);
  }
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function shortTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function relativeDate(value) {
  const diff = Math.max(0, Date.now() - value.getTime());
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return `${value.getMonth() + 1}/${value.getDate()}`;
}

function modelToolTitles(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const titles = [];
  for (const line of lines) {
    const match = /^(?:#{1,4}\s+|tool\s*:\s*)(.+)$/i.exec(line);
    if (!match) continue;
    const title = match[1].replace(/[*_`#]/g, '').trim();
    if (/^tool calls?\s*[:—-]/i.test(title)) continue;
    if (title && title.length <= 96) titles.push(title);
  }
  return titles;
}

function unconsumedTitles(incoming, consumed, queued) {
  const counts = new Map();
  for (const title of [...consumed, ...queued]) {
    const key = String(title).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = [];
  for (const title of incoming) {
    const key = String(title).toLowerCase();
    const n = counts.get(key) ?? 0;
    if (n > 0) {
      counts.set(key, n - 1);
    } else {
      out.push(title);
    }
  }
  return out;
}

function modelToolGroupTitle(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const heading = /^#{1,4}\s+(.+)$/.exec(lines[i]);
    if (!heading) continue;
    const clean = heading[1].replace(/[*_`#]/g, '').trim();
    const match = /^tool calls?\s*[:—-]\s*(.+)$/i.exec(clean);
    const title = match?.[1]?.trim();
    if (title && title.length <= 96) return title;
  }
  return '';
}

function toolTitle(name, args) {
  const tool = String(name ?? 'tool').toLowerCase();
  const input = args && typeof args === 'object' ? args : {};
  const path = String(input.path ?? input.file_path ?? input.filePath ?? '').replace(/\\/g, '/');
  const file = path.split('/').filter(Boolean).at(-1);
  if (tool === 'read') return file ? `Read ${file}` : 'Read files';
  if (tool === 'write') return file ? `Write ${file}` : 'Write file';
  if (tool === 'edit') return file ? `Edit ${file}` : 'Edit file';
  if (tool === 'grep') return `Search ${clip(input.pattern ?? input.query ?? 'project', 44)}`;
  if (tool === 'find' || tool === 'ls') return path ? `Inspect ${file || path}` : 'Inspect project';
  if (tool === 'bash' || tool === 'shell' || tool === 'shell_command') {
    return shellToolTitle(input.command ?? input.cmd ?? input.script ?? 'command');
  }
  return `${tool.replace(/[_-]+/g, ' ')} call`;
}

function shellToolTitle(value) {
  const raw = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  const command = raw
    .replace(/^\s*(?:cd|Set-Location)\s+(?:"[^"]*"|'[^']*'|[^;&]+?)\s*(?:&&|;)\s*/i, '')
    .trim();
  const lower = command.toLowerCase();
  if ((/\bfind\b/.test(lower) && /(?:-type\s+f|-file\b)/.test(lower)) || /\bget-childitem\b/.test(lower)) {
    return 'List project files';
  }
  if (/\bwc\s+-l\b/.test(lower) || /measure-object\s+-line\b/.test(lower)) return 'Count project lines';
  if (/\b(?:npm|pnpm|yarn)\b[^;&]*(?:smoke|test)\b/.test(lower) || /scripts[\\/]smoke\b/.test(lower)) {
    return 'Run smoke tests';
  }
  if (/scripts[\\/]bench\b|\bbenchmark\b/.test(lower)) return 'Benchmark renderer';
  if (/\bgit\s+status\b/.test(lower)) return 'Check Git status';
  if (/\bgit\s+diff\b/.test(lower)) return 'Inspect Git changes';
  if (/\b(?:rg|grep|select-string)\b/.test(lower)) return 'Search project text';
  if (/\b(?:curl|invoke-webrequest|wget)\b/.test(lower)) return 'Fetch remote data';
  if (/^echo\b/i.test(command)) return `Print ${clip(command.slice(4).replace(/["']/g, '').trim() || 'message', 40)}`;
  const first = command.split(/\s*(?:&&|;)\s*/)[0] || raw || 'command';
  return `Run ${clip(first, 52)}`;
}

function stripToolTitleHeadings(text, titles) {
  if (!titles?.length) return text;
  const pending = new Set(titles.map((title) => title.trim().toLowerCase()));
  return String(text ?? '')
    .split('\n')
    .filter((line) => {
      const match = /^\s*#{1,4}\s+(.+?)\s*$/.exec(line);
      if (!match) return true;
      const title = match[1].replace(/[*_`#]/g, '').trim().toLowerCase();
      if (!pending.has(title)) return true;
      pending.delete(title);
      return false;
    })
    .join('\n')
    .replace(/^\s+|\s+$/g, '');
}

function clip(value, n) {
  const text = String(value ?? '').trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

function formatError(error) {
  return String(error?.message ?? error ?? 'Unknown Approx error');
}

function isAbortError(error) {
  const text = formatError(error).toLowerCase();
  return error?.name === 'AbortError' || text.includes('abort') || text.includes('interrupt');
}
