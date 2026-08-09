import { Spring, clamp } from './anim.js';

export const EFFORT_DESCRIPTIONS = {
  off: 'No extended reasoning · quickest response',
  minimal: 'A brief check before answering',
  low: 'Light reasoning for straightforward work',
  medium: 'Balanced speed and problem-solving depth',
  high: 'Deeper reasoning for difficult work',
  xhigh: 'Maximum available reasoning depth',
};

export function effortDescription(value) {
  return EFFORT_DESCRIPTIONS[String(value ?? '').toLowerCase()]
    || 'Model-provided reasoning level';
}

export function createEffortPickerState(value = {}) {
  const options = Array.isArray(value.options) ? value.options.map(String) : [];
  const index = clamp(Number(value.index) || 0, 0, Math.max(0, options.length - 1));
  return {
    open: !!value.open,
    options,
    index,
    currentIndex: clamp(Number(value.currentIndex) || 0, 0, Math.max(0, options.length - 1)),
    hits: [],
    geometry: null,
    anim: new Spring(value.open ? 1 : 0, { stiff: 19, damp: 0.84 }),
    cursor: new Spring(index, { stiff: 24, damp: 0.82 }),
    pulse: new Spring(0, { stiff: 15, damp: 0.8 }),
  };
}

export const effortPickerMethods = {
  openEffortPicker() {
    const options = this.st.effortOptions.map(String);
    if (!options.length) return this.toast('current model has no configurable effort levels', 'warn');
    if (this.st.effortPicker?.open) this.closeEffortPicker(false, 'superseded');

    const current = this.st.pendingEffort || this.st.effort;
    const currentIndex = Math.max(0, options.indexOf(current));
    const state = createEffortPickerState({
      open: true,
      options,
      index: currentIndex,
      currentIndex,
    });
    this.st.effortPicker = state;
    state.anim.set(1);
    state.cursor.set(currentIndex, true);
    state.pulse.set(1, true);
    state.pulse.set(0);
    this.s?.invalidate?.();
    this.requestFrame?.();

    return new Promise((resolve) => {
      this._effortPickerResolver = resolve;
    });
  },

  moveEffortPicker(delta, edge = '') {
    const state = this.st.effortPicker;
    if (!state?.open || !state.options.length) return false;
    const next = edge === 'start' ? 0
      : edge === 'end' ? state.options.length - 1
        : clamp(state.index + delta, 0, state.options.length - 1);
    if (next === state.index) return true;
    state.index = next;
    state.cursor.set(next, !!this.st.reduceMotion);
    state.pulse.set(1, true);
    state.pulse.set(0);
    this.s?.invalidate?.();
    return true;
  },

  closeEffortPicker(apply = false, reason = '') {
    const state = this.st.effortPicker;
    if (!state?.open) return false;
    const value = state.options[state.index] ?? '';
    state.open = false;
    state.anim.set(0, !!this.st.reduceMotion);
    if (apply && value) this.setEffort(value);
    const resolve = this._effortPickerResolver;
    this._effortPickerResolver = null;
    try { resolve?.({ applied: !!apply, value, reason }); } catch { /* UI consumers are isolated. */ }
    this.s?.invalidate?.();
    this.requestFrame?.();
    return true;
  },

  effortPickerKey(k) {
    if (!this.st.effortPicker?.open) return false;
    if (k.name === 'escape') return this.closeEffortPicker(false, 'cancelled');
    if (k.name === 'left' || k.name === 'up' || k.name === 'wheelup') return this.moveEffortPicker(-1);
    if (k.name === 'right' || k.name === 'down' || k.name === 'wheeldown') return this.moveEffortPicker(1);
    if (k.name === 'home') return this.moveEffortPicker(0, 'start');
    if (k.name === 'end') return this.moveEffortPicker(0, 'end');
    if (k.name === 'enter' || k.name === 'space') return this.closeEffortPicker(true, 'applied');
    return true;
  },

  effortPickerPointer(x, y, activate = false) {
    const state = this.st.effortPicker;
    if (!state?.open) return false;
    const hit = state.hits.find((item) => x >= item.x1 && x <= item.x2
      && y >= item.y1 && y <= item.y2);
    if (!hit) {
      if (activate && state.geometry) {
        const g = state.geometry;
        if (x < g.x || x >= g.x + g.w || y < g.y || y >= g.y + g.h) {
          return this.closeEffortPicker(false, 'outside');
        }
      }
      return true;
    }
    if (hit.kind === 'option') {
      const delta = hit.index - state.index;
      return this.moveEffortPicker(delta);
    }
    if (!activate) return true;
    if (hit.kind === 'apply') return this.closeEffortPicker(true, 'applied');
    if (hit.kind === 'cancel') return this.closeEffortPicker(false, 'cancelled');
    return true;
  },

  stepEffortPickerAnimations(dt) {
    const state = this.st.effortPicker;
    state?.anim?.step(dt);
    state?.cursor?.step(dt);
    state?.pulse?.step(dt);
  },
};
