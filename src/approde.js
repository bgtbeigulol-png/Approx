// Approde — hot-swappable presets. Skills and prompts can be toggled on/off at
// runtime; the backend rebuilds the system prompt without dropping conversation
// history. A preset is a named set of disabled skills/prompts. The model may
// request its own changes, but only through explicit user approval.

import { Spring, clamp } from './anim.js';
import { invalidateLayoutTree } from './ui/transcript.js';

export const APPRODE_MIN_W = 32;
export const APPRODE_MAX_W = 52;
export const APPRODE_TRANSCRIPT_MIN_W = 46;
export const APPRODE_MAX_PRESETS = 24;

export function canShowApprode(screenW) {
  return !Number.isFinite(screenW) || screenW >= APPRODE_TRANSCRIPT_MIN_W + APPRODE_MIN_W;
}

export function createApprodeState(seed = {}) {
  const source = seed && typeof seed === 'object' && !Array.isArray(seed) ? seed : {};
  const presets = normalizePresets(source.presets);
  return {
    open: !!source.open,
    focused: !!source.open,
    catalog: { skills: [], prompts: [] },
    presets,
    activePreset: String(source.activePreset ?? ''),
    disabledSkills: new Set(stringArray(source.disabledSkills)),
    disabledPrompts: new Set(stringArray(source.disabledPrompts)),
    dirty: false,
    applying: false,
    index: 0,
    scroll: 0,
    mode: 'browse', // 'browse' | 'save'
    saveName: '',
    saveCursor: 0,
    hits: [],
    geometry: null,
    anim: new Spring(source.open ? 1 : 0, { stiff: 19, damp: 0.86 }),
    cursor: new Spring(0, { stiff: 24, damp: 0.82 }),
    pulse: new Spring(0, { stiff: 15, damp: 0.8 }),
  };
}

export function normalizePresets(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const name = String(raw?.name ?? '').trim().slice(0, 60);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      disabledSkills: [...new Set(stringArray(raw?.disabledSkills))],
      disabledPrompts: [...new Set(stringArray(raw?.disabledPrompts))],
    });
    if (out.length >= APPRODE_MAX_PRESETS) break;
  }
  return out;
}

export function serializeApprodeState(state) {
  if (!state) return {};
  return {
    presets: state.presets.map((preset) => ({
      name: preset.name,
      disabledSkills: [...preset.disabledSkills],
      disabledPrompts: [...preset.disabledPrompts],
    })),
    activePreset: state.activePreset,
    disabledSkills: [...state.disabledSkills],
    disabledPrompts: [...state.disabledPrompts],
  };
}

/** Flat display model: section heads plus navigable rows. */
export function approdeRows(state) {
  const rows = [{ kind: 'section', label: 'PRESETS' }];
  for (const preset of state.presets) {
    rows.push({ kind: 'preset', name: preset.name, active: preset.name === state.activePreset });
  }
  rows.push({ kind: 'action', action: 'save', label: 'Save current as preset…' });
  rows.push({ kind: 'section', label: 'SKILLS' });
  if (!state.catalog.skills.length) rows.push({ kind: 'empty', label: 'no skills discovered' });
  for (const skill of state.catalog.skills) {
    rows.push({
      kind: 'skill', name: skill.name, description: skill.description || '',
      enabled: !state.disabledSkills.has(skill.name),
    });
  }
  rows.push({ kind: 'section', label: 'PROMPTS' });
  if (!state.catalog.prompts.length) rows.push({ kind: 'empty', label: 'no prompts discovered' });
  for (const prompt of state.catalog.prompts) {
    rows.push({
      kind: 'prompt', name: prompt.name, description: prompt.description || '',
      enabled: !state.disabledPrompts.has(prompt.name),
    });
  }
  rows.push({ kind: 'section', label: '' });
  rows.push({ kind: 'action', action: 'apply', label: 'Apply & re-work' });
  rows.push({ kind: 'action', action: 'reset', label: 'Enable everything' });
  return rows;
}

/** True for rows the cursor can land on (not section heads or spacers). */
export function isNavigable(row) {
  return row.kind !== 'section' && row.kind !== 'empty';
}

/**
 * Rows the cursor can land on. Callers that also need the full row list must
 * filter that list with isNavigable() instead — approdeRows() returns fresh
 * objects each call, so rows from two calls never match by identity.
 */
export function navigableRows(state) {
  return approdeRows(state).filter(isNavigable);
}

export const approdeMethods = {
  toggleApprode() {
    const st = this.st.approde;
    if (!st) return;
    if (!st.open) return this.openApprode();
    if (!st.focused) { st.focused = true; this.s?.invalidate?.(); this.requestFrame?.(); return; }
    return this.closeApprode();
  },

  openApprode() {
    const st = this.st.approde;
    if (!st) return;
    if (!canShowApprode(this.s?.w)) {
      st.open = false;
      st.focused = false;
      st.anim.set(0, true);
      this.toast?.(`approde needs at least ${APPRODE_TRANSCRIPT_MIN_W + APPRODE_MIN_W} columns`, 'warn');
      this.s?.invalidate?.();
      return false;
    }
    if (this.backend?.getResourceCatalog) {
      try {
        const backendState = st.dirty || st.applying ? null : this.backend.serializeApprode?.();
        this.hydrateApprodeCatalog(this.backend.getResourceCatalog(), backendState);
      } catch { /* catalog is best-effort; the panel still opens. */ }
    }
    st.open = true;
    st.focused = true;
    st.mode = 'browse';
    st.index = clamp(st.index, 0, Math.max(0, navigableRows(st).length - 1));
    st.anim.set(1, !!this.st.reduceMotion);
    st.cursor.set(st.index, true);
    st.pulse.set(1, true);
    st.pulse.set(0);
    this.reflowForApprode();
    return true;
  },

  closeApprodeForNarrowScreen() {
    const st = this.st.approde;
    if (!st?.open || canShowApprode(this.s?.w)) return false;
    st.open = false;
    st.focused = false;
    st.mode = 'browse';
    st.hits = [];
    st.geometry = null;
    st.anim.set(0, true);
    this.toast?.(`approde closed below ${APPRODE_TRANSCRIPT_MIN_W + APPRODE_MIN_W} columns`, 'warn');
    return true;
  },

  closeApprode() {
    const st = this.st.approde;
    if (!st?.open) return;
    st.open = false;
    st.focused = false;
    st.mode = 'browse';
    st.anim.set(0, !!this.st.reduceMotion);
    this.reflowForApprode();
  },

  reflowForApprode() {
    invalidateLayoutTree(this.st.msgs);
    this.clampScroll?.();
    this.s?.invalidate?.();
    this.requestFrame?.();
  },

  moveApprode(delta, edge = '') {
    const st = this.st.approde;
    if (!st?.open) return;
    const rows = navigableRows(st);
    if (!rows.length) return;
    const next = edge === 'start' ? 0
      : edge === 'end' ? rows.length - 1
        : clamp(st.index + delta, 0, rows.length - 1);
    if (next === st.index) return;
    st.index = next;
    st.cursor.set(next, !!this.st.reduceMotion);
    st.pulse.set(1, true);
    st.pulse.set(0);
    this.s?.invalidate?.();
  },

  currentApprodeRow() {
    const st = this.st.approde;
    return navigableRows(st)[st.index] ?? null;
  },

  activateApprodeRow() {
    const st = this.st.approde;
    const row = this.currentApprodeRow();
    if (!row) return;
    if (row.kind === 'skill') return this.toggleApprodeSkill(row.name);
    if (row.kind === 'prompt') return this.toggleApprodePrompt(row.name);
    if (row.kind === 'preset') return this.applyApprodePreset(row.name);
    if (row.kind === 'action') {
      if (row.action === 'save') return this.beginApprodeSave();
      if (row.action === 'apply') return this.applyApprode();
      if (row.action === 'reset') return this.resetApprode();
    }
  },

  toggleApprodeSkill(name) {
    const st = this.st.approde;
    if (this.approdeMutationBlocked()) return false;
    if (st.disabledSkills.has(name)) st.disabledSkills.delete(name);
    else st.disabledSkills.add(name);
    this.markApprodeDirty();
  },

  toggleApprodePrompt(name) {
    const st = this.st.approde;
    if (this.approdeMutationBlocked()) return false;
    if (st.disabledPrompts.has(name)) st.disabledPrompts.delete(name);
    else st.disabledPrompts.add(name);
    this.markApprodeDirty();
  },

  markApprodeDirty() {
    const st = this.st.approde;
    st.dirty = true;
    st.activePreset = ''; // toggling diverges from any named preset
    st.pulse.set(1, true);
    st.pulse.set(0);
    this.s?.invalidate?.();
  },

  approdeMutationBlocked() {
    if (!this.st.approde?.applying) return false;
    this.toast?.('approde apply already in progress', 'warn');
    return true;
  },

  applyApprodePreset(name) {
    const st = this.st.approde;
    if (this.approdeMutationBlocked()) return false;
    const preset = st.presets.find((item) => item.name === name);
    if (!preset) return;
    st.disabledSkills = new Set(preset.disabledSkills);
    st.disabledPrompts = new Set(preset.disabledPrompts);
    st.activePreset = preset.name;
    st.dirty = true;
    return this.applyApprode();
  },

  resetApprode() {
    const st = this.st.approde;
    if (this.approdeMutationBlocked()) return false;
    st.disabledSkills = new Set();
    st.disabledPrompts = new Set();
    st.activePreset = '';
    st.dirty = true;
    return this.applyApprode();
  },

  applyApprode() {
    const st = this.st.approde;
    if (!this.backend?.applyApprodeSelection) {
      this.toast?.('approde needs a live backend', 'warn');
      return;
    }
    if (st.applying) {
      this.toast?.('approde apply already in progress', 'warn');
      return false;
    }
    const payload = {
      disabledSkills: [...st.disabledSkills],
      disabledPrompts: [...st.disabledPrompts],
      presetLabel: st.activePreset,
      rework: true,
    };
    st.applying = true;
    this.s?.invalidate?.();
    return Promise.resolve()
      .then(() => this.backend.applyApprodeSelection(payload))
      .then(() => {
        st.applying = false;
        st.dirty = false;
        this.persistPreferences?.();
        this.toast?.('approde applied', 'ok');
        this.s?.invalidate?.();
        return true;
      })
      .catch((error) => {
        st.applying = false;
        st.dirty = true;
        this.toast?.(String(error?.message ?? error), 'warn');
        this.s?.invalidate?.();
        return false;
      });
  },

  beginApprodeSave() {
    const st = this.st.approde;
    if (this.approdeMutationBlocked()) return false;
    st.mode = 'save';
    st.saveName = st.activePreset || '';
    st.saveCursor = [...st.saveName].length;
    st.pulse.set(1, true);
    st.pulse.set(0);
    this.s?.invalidate?.();
  },

  cancelApprodeSave() {
    const st = this.st.approde;
    st.mode = 'browse';
    st.saveName = '';
    this.s?.invalidate?.();
  },

  commitApprodeSave() {
    const st = this.st.approde;
    const name = String(st.saveName ?? '').trim().slice(0, 60);
    if (!name) { this.toast?.('name the preset first', 'warn'); return; }
    if (this.saveApprodePreset(name) === false) return false;
    st.mode = 'browse';
    st.saveName = '';
    return true;
  },

  saveApprodePreset(name) {
    const st = this.st.approde;
    if (this.approdeMutationBlocked()) return false;
    const entry = {
      name,
      disabledSkills: [...st.disabledSkills],
      disabledPrompts: [...st.disabledPrompts],
    };
    const existing = st.presets.findIndex((item) => item.name.toLowerCase() === name.toLowerCase());
    if (existing >= 0) st.presets[existing] = entry;
    else {
      if (st.presets.length >= APPRODE_MAX_PRESETS) {
        this.toast?.(`approde keeps at most ${APPRODE_MAX_PRESETS} presets`, 'warn');
        return false;
      }
      st.presets.push(entry);
    }
    st.activePreset = name;
    st.dirty = false;
    this.persistPreferences?.();
    this.toast?.(`preset “${name}” saved`, 'ok');
    this.s?.invalidate?.();
    return true;
  },

  deleteApprodePreset(name) {
    const st = this.st.approde;
    if (this.approdeMutationBlocked()) return false;
    const before = st.presets.length;
    st.presets = st.presets.filter((item) => item.name !== name);
    if (st.presets.length === before) return;
    if (st.activePreset === name) st.activePreset = '';
    st.index = clamp(st.index, 0, Math.max(0, navigableRows(st).length - 1));
    this.persistPreferences?.();
    this.toast?.(`preset “${name}” removed`, 'ok');
    this.s?.invalidate?.();
  },

  /** Backend told us the live set changed (user apply, model request, or ready). */
  applyApprodeEvent(event = {}) {
    this.hydrateApprodeCatalog(event.catalog ?? {}, event.state ?? null);
    this.reflowForApprode();
  },

  /**
   * Default startup behaviour: re-arm the preset that was active last session.
   * Preferences already restored the name and the disabled sets, so this only
   * has to push them down to the backend — without a re-work turn.
   */
  async resumeLastApprode() {
    const st = this.st.approde;
    if (!st || !this.backend?.applyApprodeSelection) return;
    if (!st.disabledSkills.size && !st.disabledPrompts.size && !st.activePreset) return;
    try {
      await this.backend.applyApprodeSelection({
        disabledSkills: [...st.disabledSkills],
        disabledPrompts: [...st.disabledPrompts],
        presetLabel: st.activePreset,
        rework: false,
      });
      st.dirty = false;
      if (st.activePreset) this.toast?.(`approde “${st.activePreset}” restored`, 'ok');
    } catch (error) {
      st.dirty = true;
      this.toast?.(`approde restore failed: ${String(error?.message ?? error)}`, 'warn');
      this.s?.invalidate?.();
    }
  },

  hydrateApprodeCatalog(catalog = {}, backendState = null) {
    const st = this.st.approde;
    if (!st) return;
    st.catalog = {
      skills: Array.isArray(catalog.skills) ? catalog.skills.map(normalizeCatalogItem) : [],
      prompts: Array.isArray(catalog.prompts) ? catalog.prompts.map(normalizeCatalogItem) : [],
    };
    if (backendState) {
      st.disabledPrompts = new Set(stringArray(backendState.disabledPrompts));
      st.disabledSkills = new Set(stringArray(backendState.disabledSkills));
      st.activePreset = String(backendState.activePreset ?? st.activePreset ?? '');
      st.dirty = false;
    }
    st.index = clamp(st.index, 0, Math.max(0, navigableRows(st).length - 1));
    this.s?.invalidate?.();
  },

  approdeKey(k) {
    const st = this.st.approde;
    if (!st?.open) return false;
    if (st.mode === 'save') return this.approdeSaveKey(k);
    if (k.name === 'escape') { this.closeApprode(); return true; }
    if (k.name === 'up') return this.moveApprode(-1) ?? true;
    if (k.name === 'down') return this.moveApprode(1) ?? true;
    if (k.name === 'home') return this.moveApprode(0, 'start') ?? true;
    if (k.name === 'end') return this.moveApprode(0, 'end') ?? true;
    if (k.name === 'left') { st.focused = false; this.s?.invalidate?.(); return true; }
    if (k.name === 'enter' || k.name === 'space') { this.activateApprodeRow(); return true; }
    if (k.name === 'tab') { this.applyApprode(); return true; }
    if (k.name.toLowerCase() === 's' && !k.ctrl && !k.alt) { this.beginApprodeSave(); return true; }
    return true;
  },

  approdeSaveKey(k) {
    const st = this.st.approde;
    if (k.name === 'escape') { this.cancelApprodeSave(); return true; }
    if (k.name === 'enter') { this.commitApprodeSave(); return true; }
    if (k.name === 'backspace') {
      const chars = [...st.saveName];
      if (st.saveCursor > 0) { chars.splice(st.saveCursor - 1, 1); st.saveCursor--; st.saveName = chars.join(''); }
      this.s?.invalidate?.();
      return true;
    }
    if (k.name === 'left') { st.saveCursor = Math.max(0, st.saveCursor - 1); this.s?.invalidate?.(); return true; }
    if (k.name === 'right') { st.saveCursor = Math.min([...st.saveName].length, st.saveCursor + 1); this.s?.invalidate?.(); return true; }
    if (k.name === 'space') { this.insertApprodeSaveText(' '); return true; }
    if (k.printable && !k.ctrl && !k.alt) { this.insertApprodeSaveText(k.name); return true; }
    return true;
  },

  insertApprodeSaveText(value) {
    const st = this.st.approde;
    const chars = [...st.saveName];
    const insert = [...String(value ?? '')];
    chars.splice(st.saveCursor, 0, ...insert);
    st.saveName = chars.join('').slice(0, 60);
    st.saveCursor = Math.min(60, st.saveCursor + insert.length);
    this.s?.invalidate?.();
  },

  approdePointer(x, y, activate = false) {
    const st = this.st.approde;
    if (!st?.open) return false;
    const geom = st.geometry;
    const inside = geom && x >= geom.x && x < geom.x + geom.w && y >= geom.y && y < geom.y + geom.h;
    if (!inside) {
      if (activate && st.focused) { st.focused = false; this.s?.invalidate?.(); }
      return false; // let the click fall through to the transcript
    }
    if (activate) st.focused = true;
    const hit = [...(st.hits ?? [])].reverse().find((item) =>
      x >= item.x1 && x <= item.x2 && y >= item.y1 && y <= item.y2);
    if (!hit) { if (activate) this.s?.invalidate?.(); return true; }
    if (hit.kind === 'close') { if (activate) this.closeApprode(); return true; }
    if (typeof hit.navIndex === 'number' && hit.navIndex !== st.index) {
      st.index = hit.navIndex;
      st.cursor.set(hit.navIndex, !!this.st.reduceMotion);
      this.s?.invalidate?.();
    }
    if (activate && typeof hit.navIndex === 'number') {
      if (hit.deletePreset) return this.deleteApprodePreset(hit.deletePreset);
      this.activateApprodeRow();
    }
    return true;
  },

  stepApprodeAnimations(dt) {
    const st = this.st.approde;
    st?.anim?.step(dt);
    st?.cursor?.step(dt);
    st?.pulse?.step(dt);
  },

  commandApprode(arg) {
    const raw = String(arg ?? '').trim();
    if (!raw) return this.toggleApprode();
    const [verb, ...rest] = raw.split(/\s+/);
    const name = rest.join(' ').trim();
    const action = verb.toLowerCase();
    if (action === 'save') {
      if (!name) { this.openApprode(); return this.beginApprodeSave(); }
      return this.saveApprodePreset(name.slice(0, 60));
    }
    if (action === 'load' || action === 'use') {
      const preset = this.st.approde.presets.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (!preset) return this.toast?.(`unknown preset: ${name}`, 'warn');
      this.openApprode();
      return this.applyApprodePreset(preset.name);
    }
    if (action === 'delete' || action === 'remove') {
      return this.deleteApprodePreset(name);
    }
    if (action === 'reset') return this.resetApprode();
    return this.toggleApprode();
  },
};

function normalizeCatalogItem(item) {
  return {
    name: String(item?.name ?? '').slice(0, 80),
    description: String(item?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}
