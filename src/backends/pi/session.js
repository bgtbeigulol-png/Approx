import {
  createAgentSession, ModelRuntime, SessionManager, VERSION as PI_VERSION,
} from '@earendil-works/pi-coding-agent';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  normalizeAutoCompactMode, normalizeAutoCompactPercent, normalizeAutoCompactTokens,
} from '../../compact-settings.js';
import { samePath } from '../../path-utils.js';
import { createApproxHostTools } from '../../pi-host-tools.js';
import {
  applyPlanOperation, createPlanState, hydratePlanState, serializePlanState,
} from '../../plan.js';
import {
  formatError, isAbortError, normalizeModel, oneLine, relativeDate,
  restorePlanState, sessionTranscript, shouldAutoPlan,
} from './helpers.js';

export class PiSessionMethods {
  async start() {
    if (this.started) return this;
    this.modelRuntime = await ModelRuntime.create();
    this.resourceLoader = await this.loadResourceLoader(this.cwd);
    await this.openSession({ continueSession: this.continueSession });
    return this;
  }

  async openSession({
    continueSession = false,
    sessionPath,
    model,
    effort,
    sessionManager: providedSessionManager,
    sessionFactory = createAgentSession,
  } = {}) {
    const sessionManager = providedSessionManager ?? (sessionPath
      ? SessionManager.open(sessionPath, undefined, this.cwd)
      : continueSession
        ? SessionManager.continueRecent(this.cwd)
        : SessionManager.create(this.cwd));

    const { session, modelFallbackMessage } = await sessionFactory({
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
      approde: { catalog: this.getResourceCatalog(), state: this.serializeApprode() },
    });

    const history = sessionTranscript(sessionManager.getBranch(), this.cwd);
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
    const settledBefore = Number(this.settledEventSeq || 0);
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
      // Most providers emit agent_settled before prompt() resolves. Keep one
      // fallback for transports that omit it, without publishing duplicates.
      if (Number(this.settledEventSeq || 0) === settledBefore) this.emitSettled();
    }
  }

  /** Pi can remain active between short WORK notes even when the host has not
   * opened a visible turn envelope (for example, an approved Plan continuation). */
  isBusy() {
    return !!this.session && !this.session.isIdle;
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
      allowOther: false,
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
        allowOther: false,
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
          allowOther: false,
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

  async abort() {
    this.requireSession();
    const settledBefore = Number(this.settledEventSeq || 0);
    // compact() first awaits the ordinary agent abort before installing Pi's
    // dedicated compaction controller. Yield once so an immediate escape press
    // cannot slip through that narrow hand-off window.
    if (this.manualCompaction && !this.session.isCompacting) await Promise.resolve();
    if (this.session.isCompacting) this.session.abortCompaction();
    await this.session.abort();
    if (Number(this.settledEventSeq || 0) === settledBefore) this.emitSettled();
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
        current: !!current && samePath(item.path, current),
      }));
  }

  async switchSession(path) {
    this.requireSession();
    const previous = this.sessionTransitionSnapshot();
    await this.settleSessionForTransition();
    this.closeSessionForTransition();
    this.planState = createPlanState();
    try {
      return await this.openSession({ sessionPath: String(path) });
    } catch (error) {
      await this.restoreSessionAfterTransitionFailure(previous);
      throw error;
    }
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
    await this.settleSessionForTransition();
    this.closeSessionForTransition();
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
      // If opening the new workspace installed a partial session before it
      // failed, dispose it before recovering the previous workspace.
      this.closeSessionForTransition();
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
      mode: normalizeAutoCompactMode(mode),
      percent: normalizeAutoCompactPercent(percent),
      tokens: normalizeAutoCompactTokens(tokens),
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
    const previous = this.sessionTransitionSnapshot();
    await this.settleSessionForTransition();
    this.closeSessionForTransition();
    this.planState = createPlanState();
    try {
      const session = await this.openSession({ model: previous.model, effort: previous.effort });
      this.emit({ type: 'conversation_new', sessionId: session.sessionId, sessionFile: session.sessionFile });
      return session.sessionId;
    } catch (error) {
      await this.restoreSessionAfterTransitionFailure(previous);
      throw error;
    }
  }

  sessionTransitionSnapshot() {
    return {
      sessionFile: this.session?.sessionFile || '',
      model: this.session?.model,
      effort: this.session?.thinkingLevel,
      plan: serializePlanState(this.planState),
    };
  }

  async settleSessionForTransition() {
    const session = this.session;
    if (!session) return;
    if (session.isStreaming) await session.abort();
    if (session.isIdle === false && typeof session.waitForIdle === 'function') {
      await session.waitForIdle();
    }
  }

  closeSessionForTransition() {
    this.unsubscribePi?.();
    this.unsubscribePi = null;
    this.session?.dispose();
    this.session = null;
    this.resetAdapterState();
  }

  async restoreSessionAfterTransitionFailure(previous) {
    // openSession can fail after it has already installed a partial session.
    // Tear that instance down before reopening the known-good branch.
    this.closeSessionForTransition();
    this.planState = hydratePlanState(previous?.plan);
    if (!previous?.sessionFile) return false;
    try {
      await this.openSession({
        sessionPath: previous.sessionFile,
        model: previous.model,
        effort: previous.effort,
      });
      return true;
    } catch {
      this.planState = hydratePlanState(previous.plan);
      return false;
    }
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

}
