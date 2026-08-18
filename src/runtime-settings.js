import { T } from './theme.js';
import {
  normalizeAutoCompactMode, normalizeAutoCompactPercent, normalizeAutoCompactTokens,
} from './compact-settings.js';
import {
  ACCENTS as ACCENT_DEFS,
  formatCompactTokens,
} from './settings.js';
import { serializeApprodeState } from './approde.js';
import { savePreferences } from './persistence.js';
import { invalidateLayoutTree } from './ui/transcript.js';
import { serializeUsageHistory } from './usage-history.js';

const ACCENTS = ACCENT_DEFS.map((a) => a.color);

/** Runtime option setters shared by settings, palette, slash commands, and harness. */
export const runtimeSettingMethods = {
  setAccent(i) {
    this.st.accent = ((i % ACCENTS.length) + ACCENTS.length) % ACCENTS.length;
    T.accent = ACCENTS[this.st.accent];
    this.s.invalidate();
    this.persistPreferences();
  },

  setGrain(v) {
    this.st.grain = !!v;
    this.s.invalidate();
    this.persistPreferences();
  },

  setReduceMotion(v) {
    this.st.reduceMotion = !!v;
    this.persistPreferences();
  },

  setShowFps(v) {
    this.st.showFps = !!v;
    this.s.invalidate();
    this.persistPreferences();
  },

  setAutoCompactMode(mode) {
    this.st.autoCompactMode = normalizeAutoCompactMode(mode);
    this.syncAutoCompactThreshold(true);
    this.persistPreferences();
    this.s.invalidate();
    this.toast(`auto compact by ${this.st.autoCompactMode}`, 'ok');
  },

  setAutoCompactPercent(value) {
    this.st.autoCompactPercent = normalizeAutoCompactPercent(value);
    this.syncAutoCompactThreshold(true);
    this.persistPreferences();
    this.s.invalidate();
    this.toast(`auto compact at ${this.st.autoCompactPercent}%`, 'ok');
  },

  setAutoCompactTokens(value) {
    this.st.autoCompactTokens = normalizeAutoCompactTokens(value);
    this.syncAutoCompactThreshold(true);
    this.persistPreferences();
    this.s.invalidate();
    this.toast(`auto compact at ${formatCompactTokens(this.st.autoCompactTokens)}`, 'ok');
  },

  syncAutoCompactThreshold(reportErrors = false) {
    const apply = this.backend?.setAutoCompactThreshold;
    if (!apply) return null;
    try {
      return apply.call(this.backend, {
        mode: normalizeAutoCompactMode(this.st.autoCompactMode),
        percent: normalizeAutoCompactPercent(this.st.autoCompactPercent),
        tokens: normalizeAutoCompactTokens(this.st.autoCompactTokens),
      });
    } catch (error) {
      if (reportErrors) this.toast(String(error?.message ?? error), 'warn');
      return null;
    }
  },

  compactContext(instructions = '') {
    if (!this.backend?.compact) return this.toast('compact needs a live backend', 'warn');
    if (this._activeTurn || this.st.busy || this.st.compact?.phase === 'running') {
      return this.toast('compact waits for the current task to settle', 'warn');
    }
    this.st.busy = true;
    this.st.elapsed = 0;
    const request = this.backend.compact(String(instructions ?? '').trim());
    void Promise.resolve(request).catch((error) => {
      if (this.st.compact?.phase !== 'error') {
        this.st.busy = false;
        this.toast(String(error?.message ?? error), 'warn');
      }
    });
    return true;
  },

  setModel(model) {
    const next = typeof model === 'string' ? { label: model } : model;
    if (this._activeTurn || this.st.busy) {
      this.st.pendingModel = next;
      if (next?.provider && next?.id) this.preferences.model = { provider: next.provider, id: next.id };
      this.persistPreferences();
      this.s.invalidate();
      return this.toast(`model ${String(next?.label ?? next?.id)} queued · applies after current task`, 'info');
    }
    this.st.model = String(next?.label ?? next?.id ?? 'Approx');
    if (next?.provider && next?.id) this.preferences.model = { provider: next.provider, id: next.id };
    this.s.invalidate();
    this.persistPreferences();
    if (this.backend && next?.provider && next?.id) {
      void this.backend.setModel(next).catch((error) => {
        this.onBackendEvent({ type: 'error', error: String(error?.message ?? error) });
      });
    }
  },

  cycleModel() {
    const options = this.st.modelOptions;
    if (options.length) {
      const current = this.st.pendingModel?.label ?? this.st.model;
      const i = Math.max(0, options.findIndex((model) => model.label === current));
      return this.setModel(options[(i + 1) % options.length]);
    }
    if (!this.backend?.cycleModel) return this.toast('model switching needs a live backend', 'warn');
    void this.backend.cycleModel().catch((error) => this.toast(String(error?.message ?? error), 'warn'));
  },

  setEffort(level) {
    const effort = String(level ?? '');
    if (!effort) return;
    if (this._activeTurn || this.st.busy) {
      this.st.pendingEffort = effort;
      this.preferences.effort = effort;
      this.persistPreferences();
      this.s.invalidate();
      return this.toast(`effort ${effort} queued · applies after current task`, 'info');
    }
    if (!this.backend?.setEffort) {
      this.st.effort = effort;
      this.persistPreferences();
      return this.toast(`effort ${effort}`, 'ok');
    }
    try {
      this.backend.setEffort(effort);
    } catch (error) {
      this.onBackendEvent({ type: 'error', error: String(error?.message ?? error) });
    }
  },

  cycleEffort() {
    const options = this.st.effortOptions;
    if (options.length) {
      const current = this.st.pendingEffort || this.st.effort;
      const i = Math.max(0, options.indexOf(current));
      return this.setEffort(options[(i + 1) % options.length]);
    }
    if (!this.backend?.cycleEffort) return this.toast('effort switching needs a live backend', 'warn');
    try {
      const effort = this.backend.cycleEffort();
      if (!effort) this.toast('current model has one effort level', 'warn');
    } catch (error) {
      this.onBackendEvent({ type: 'error', error: String(error?.message ?? error) });
    }
  },

  setMarkdown(enabled) {
    this.st.markdown = !!enabled;
    for (const msg of this.st.msgs) {
      msg.markdown = msg.role !== 'user' && msg.role !== 'tool' && msg.role !== 'toolgroup' && this.st.markdown;
    }
    invalidateLayoutTree(this.st.msgs);
    this.s.invalidate();
    this.clampScroll();
    this.persistPreferences();
    this.toast(`Markdown ${this.st.markdown ? 'on' : 'off'}`, 'ok');
  },

  persistPreferences() {
    if (!this.persistenceEnabled) return;
    const current = this.st.pendingModel ?? this.st.modelOptions.find((model) => model.label === this.st.model);
    this.preferences = {
      ...this.preferences,
      accent: this.st.accent,
      grain: this.st.grain,
      reduceMotion: this.st.reduceMotion,
      showFps: this.st.showFps,
      markdown: this.st.markdown,
      autoCompactMode: this.st.autoCompactMode,
      autoCompactPercent: this.st.autoCompactPercent,
      autoCompactTokens: this.st.autoCompactTokens,
      effort: this.st.pendingEffort || this.st.effort,
      usageHistory: serializeUsageHistory(this.st.usageHistory),
      approde: serializeApprodeState(this.st.approde),
      ...(current ? { model: { provider: current.provider, id: current.id } } : {}),
      ...(this.st.sessionFile ? { lastSession: this.st.sessionFile } : {}),
    };
    savePreferences(this.preferences);
  },

  restoreRuntimePreferences() {
    if (this._runtimePrefsRestored || !this.backend) return;
    this._runtimePrefsRestored = true;
    const wanted = this.preferences.model;
    const model = wanted && this.st.modelOptions.find((item) =>
      item.provider === wanted.provider && item.id === wanted.id);
    if (model && model.label !== this.st.model) this.setModel(model);
    const effort = String(this.preferences.effort ?? '');
    if (effort && effort !== this.st.effort && this.st.effortOptions.includes(effort)) this.setEffort(effort);
    this.syncAutoCompactThreshold();
    this.persistPreferences();
  },

  async applyPendingRuntimeChanges() {
    const model = this.st.pendingModel;
    const effort = this.st.pendingEffort;
    if (!model && !effort) return false;
    this.st.pendingModel = null;
    this.st.pendingEffort = '';
    if (model) {
      if (this.backend && model.provider && model.id) await this.backend.setModel(model);
      else this.st.model = String(model.label ?? model.id ?? this.st.model);
    }
    if (effort) {
      if (this.backend?.setEffort) await this.backend.setEffort(effort);
      else this.st.effort = effort;
    }
    this.persistPreferences();
    this.s.invalidate();
    return true;
  },

  commandModel(arg) {
    if (!arg) return this.cycleModel();
    const q = String(arg).toLowerCase();
    const model = this.st.modelOptions.find((item) =>
      item.label.toLowerCase() === q
      || item.id.toLowerCase() === q
      || `${item.provider}/${item.id}`.toLowerCase() === q);
    if (!model) return this.toast(`unknown model: ${arg}`, 'warn');
    this.setModel(model);
  },

  commandEffort(arg) {
    if (!arg) return this.openEffortPicker();
    const effort = this.st.effortOptions.find((item) => item.toLowerCase() === String(arg).toLowerCase());
    if (!effort) return this.toast(`unknown effort: ${arg}`, 'warn');
    this.setEffort(effort);
  },

  commandEffortDebug() {
    return this.openEffortPicker({ debug: true, previewOnly: true });
  },

  commandMarkdown(arg) {
    const value = String(arg ?? '').toLowerCase();
    if (!value) return this.setMarkdown(!this.st.markdown);
    if (value !== 'on' && value !== 'off') return this.toast('choose Markdown on or off', 'warn');
    this.setMarkdown(value === 'on');
  },

  cycleAccent() {
    this.setAccent(this.st.accent + 1);
    this.toast(`accent ${this.st.accent + 1}/${ACCENTS.length}`, 'ok');
  },

  toggleGrain() {
    this.setGrain(!this.st.grain);
    this.toast(`grain ${this.st.grain ? 'on' : 'off'}`, 'ok');
  },

  toggleMotion() {
    this.setReduceMotion(!this.st.reduceMotion);
    this.toast(`motion ${this.st.reduceMotion ? 'reduced' : 'full'}`, 'ok');
  },

  toggleFps() {
    this.setShowFps(!this.st.showFps);
  },
};
