import { DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent';
import { formatError, mergeCatalog } from './helpers.js';
import {
  APPRODE_CONTROL_INSTRUCTION, APPROX_CONTROL_INSTRUCTION, FILE_MENTION_INSTRUCTION,
  TOOL_TITLE_INSTRUCTION,
} from './instructions.js';

export class PiResourceMethods {
  async loadResourceLoader(cwd) {
    const filter = this.approdeFilter;
    const catalog = this.approdeCatalog;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      appendSystemPrompt: [
        TOOL_TITLE_INSTRUCTION,
        APPROX_CONTROL_INSTRUCTION,
        FILE_MENTION_INSTRUCTION,
        APPRODE_CONTROL_INSTRUCTION,
      ],
      // These overrides run on every loader.reload(), reading the mutable
      // approdeFilter live. That is what makes skills and prompts hot-swappable
      // without tearing down the model runtime.
      skillsOverride: (base) => {
        // Remember the full catalog so the sidebar can list disabled items too.
        catalog.skills = (base.skills ?? []).map((skill) => ({
          name: skill.name, description: skill.description ?? '',
        }));
        const skills = (base.skills ?? []).filter((skill) => !filter.disabledSkills.has(skill.name));
        return { skills, diagnostics: base.diagnostics };
      },
      promptsOverride: (base) => {
        catalog.prompts = (base.prompts ?? []).map((prompt) => ({
          name: prompt.name, description: prompt.description ?? '',
        }));
        const prompts = (base.prompts ?? []).filter((prompt) => !filter.disabledPrompts.has(prompt.name));
        return { prompts, diagnostics: base.diagnostics };
      },
      appendSystemPromptOverride: (base) => {
        const off = [];
        if (filter.disabledSkills.size) off.push(`Disabled skills: ${[...filter.disabledSkills].join(', ')}.`);
        if (filter.disabledPrompts.size) off.push(`Disabled prompts: ${[...filter.disabledPrompts].join(', ')}.`);
        if (!off.length) return base;
        return [...base, `Approde active set — the following are turned OFF right now and must be treated as unavailable: ${off.join(' ')}`];
      },
    });
    await loader.reload();
    return loader;
  }

  getResourceCatalog() {
    // Prefer the live loader (authoritative names); fall back to the last
    // catalog captured during a reload override.
    const loader = this.resourceLoader;
    try {
      if (loader?.getSkills && loader?.getPrompts) {
        const skills = (loader.getSkills().skills ?? this.approdeCatalog.skills);
        const prompts = (loader.getPrompts().prompts ?? this.approdeCatalog.prompts);
        // getSkills reflects the *filtered* set; merge with the captured full
        // catalog so disabled entries stay visible in the sidebar.
        return {
          skills: mergeCatalog(this.approdeCatalog.skills, skills),
          prompts: mergeCatalog(this.approdeCatalog.prompts, prompts),
        };
      }
    } catch { /* fall through to captured catalog */ }
    return {
      skills: this.approdeCatalog.skills.map((s) => ({ name: s.name, description: s.description })),
      prompts: this.approdeCatalog.prompts.map((p) => ({ name: p.name, description: p.description })),
    };
  }

  serializeApprode() {
    return {
      disabledSkills: [...this.approdeFilter.disabledSkills],
      disabledPrompts: [...this.approdeFilter.disabledPrompts],
      activePreset: this.approdeFilter.activePreset,
    };
  }

  // Serialize resource/session reloads. Both the UI and model tool can request a
  // change, and DefaultResourceLoader.reload() is not a transactional primitive.
  applyApprodeSelection(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    return this.queueApprodeSelection(() => ({
      disabledSkills: stringList(source.disabledSkills),
      disabledPrompts: stringList(source.disabledPrompts),
      presetLabel: String(source.presetLabel || ''),
      rework: source.rework !== false,
      reason: 'user',
    }));
  }

  queueApprodeSelection(buildSelection) {
    const previous = this.approdeApplyTask ?? Promise.resolve();
    const task = Promise.resolve(previous)
      .catch(() => {})
      .then(() => this.commitApprodeSelection(buildSelection()));
    this.approdeApplyTask = task;
    return task.finally(() => {
      if (this.approdeApplyTask === task) this.approdeApplyTask = null;
    });
  }

  async commitApprodeSelection({
    disabledSkills = [], disabledPrompts = [], presetLabel = '', rework = true, reason = 'user',
  } = {}) {
    const previous = {
      disabledSkills: new Set(this.approdeFilter.disabledSkills),
      disabledPrompts: new Set(this.approdeFilter.disabledPrompts),
      activePreset: this.approdeFilter.activePreset,
    };
    this.approdeFilter.disabledSkills = new Set(stringList(disabledSkills));
    this.approdeFilter.disabledPrompts = new Set(stringList(disabledPrompts));
    this.approdeFilter.activePreset = String(presetLabel || '');

    try {
      if (this.resourceLoader?.reload) await this.resourceLoader.reload();
      // Rebuild the system prompt in place, preserving conversation history.
      if (this.session?.reload) await this.session.reload();
    } catch (error) {
      this.approdeFilter.disabledSkills = previous.disabledSkills;
      this.approdeFilter.disabledPrompts = previous.disabledPrompts;
      this.approdeFilter.activePreset = previous.activePreset;
      let rollbackError = null;
      try {
        if (this.resourceLoader?.reload) await this.resourceLoader.reload();
        if (this.session?.reload) await this.session.reload();
      } catch (failure) {
        rollbackError = failure;
      }
      const original = error instanceof Error ? error : new Error(formatError(error));
      if (rollbackError) original.approdeRollbackError = formatError(rollbackError);
      throw original;
    }

    this.emit({
      type: 'approde',
      catalog: this.getResourceCatalog(),
      state: this.serializeApprode(),
      reason,
    });

    if (rework) this.queueLiveApprodeRevision();
    return this.serializeApprode();
  }

  queueLiveApprodeRevision() {
    const session = this.session;
    const active = !!session && (session.isStreaming || session.isIdle === false);
    if (!active && !this.approdeRevisionTask) return false;
    this.approdeRevisionPending = true;
    if (this.approdeRevisionTask) return true;
    this.approdeRevisionTask = this.runLiveApprodeRevisionLoop()
      .catch((error) => this.emit({ type: 'status', kind: 'warn', text: `Approde restart failed: ${formatError(error)}` }))
      .finally(() => { this.approdeRevisionTask = null; });
    return true;
  }

  async runLiveApprodeRevisionLoop() {
    while (this.approdeRevisionPending) {
      this.approdeRevisionPending = false;
      const session = this.session;
      if (!session) return;
      if (session.isStreaming) await session.abort();
      if (session.isIdle === false) await session.waitForIdle();
      await Promise.resolve();
      if (this.session !== session) return;
      if (this.approdeRevisionPending) continue;
      await session.sendCustomMessage({
        customType: 'approx-approde-live-revision',
        content: 'The user changed the active approde set (skills/prompts) while you were working. Your available capabilities may have changed — a disabled skill or prompt is now genuinely unavailable, and a newly enabled one is now usable. Re-evaluate the current task against the new set and continue from it now.',
        display: false,
        details: { approde: this.serializeApprode() },
      }, { triggerTurn: true });
    }
  }

  // Model-initiated change, already user-approved by the caller. Update the set
  // immediately (so serialization is correct), then reload and re-work.
  applyApprodeFromModel({ enableSkills = [], disableSkills = [], enablePrompts = [], disablePrompts = [] } = {}) {
    return this.queueApprodeSelection(() => {
      const nextSkills = new Set(this.approdeFilter.disabledSkills);
      const nextPrompts = new Set(this.approdeFilter.disabledPrompts);
      for (const name of stringList(disableSkills)) nextSkills.add(name);
      for (const name of stringList(enableSkills)) nextSkills.delete(name);
      for (const name of stringList(disablePrompts)) nextPrompts.add(name);
      for (const name of stringList(enablePrompts)) nextPrompts.delete(name);
      return {
        disabledSkills: [...nextSkills],
        disabledPrompts: [...nextPrompts],
        presetLabel: '',
        rework: false, // the tool result naturally continues the active turn
        reason: 'model',
      };
    });
  }

}

function stringList(value) {
  return Array.isArray(value) ? value.map(String) : [];
}
