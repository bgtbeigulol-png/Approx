// Saved-conversation picker state and interaction. Kept outside app.js so the app
// shell only decides which layer owns a key; session browsing owns its own logic.

import { Spring, clamp } from './anim.js';

export const SESSION_ROWS = 8;

export function createSessionPickerState() {
  return {
    open: false,
    loading: false,
    items: [],
    index: 0,
    scroll: 0,
    anim: new Spring(0, { stiff: 18, damp: 0.9 }),
  };
}

export const sessionMethods = {
  openSessions() {
    if (!this.backend?.listSessions) return this.toast('saved conversations need a live backend', 'warn');
    if (this.st.palette) this.closePalette();
    if (this.st.jump) this.closeJump();
    if (this.st.view === 'settings') this.closeSettings();
    const picker = this.st.sessionPicker;
    picker.open = true;
    picker.loading = true;
    picker.items = [];
    picker.index = 0;
    picker.scroll = 0;
    picker.anim.set(1);
    void this.backend.listSessions().then((items) => {
      if (!picker.open) return;
      picker.items = items;
      picker.loading = false;
      picker.index = Math.max(0, items.findIndex((item) => item.current));
      this.clampSessionScroll();
      this.s.invalidate();
    }).catch((error) => {
      picker.loading = false;
      this.toast(String(error?.message ?? error), 'warn');
    });
  },

  closeSessions() {
    this.st.sessionPicker.open = false;
    this.st.sessionPicker.anim.set(0);
  },

  clampSessionScroll() {
    const picker = this.st.sessionPicker;
    const rows = Math.min(SESSION_ROWS, picker.items.length);
    if (picker.index < picker.scroll) picker.scroll = picker.index;
    if (picker.index >= picker.scroll + rows) picker.scroll = picker.index - rows + 1;
    picker.scroll = clamp(picker.scroll, 0, Math.max(0, picker.items.length - rows));
  },

  moveSession(d) {
    const picker = this.st.sessionPicker;
    if (!picker.items.length) return;
    picker.index = (picker.index + d + picker.items.length) % picker.items.length;
    this.clampSessionScroll();
  },

  sessionKey(k) {
    if (k.name === 'escape' || (k.ctrl && k.name === 's')) return this.closeSessions();
    if (k.name === 'wheelup' || k.name === 'up' || (k.ctrl && k.name === 'k')) return this.moveSession(-1);
    if (k.name === 'wheeldown' || k.name === 'down' || (k.ctrl && k.name === 'n')) return this.moveSession(1);
    if (k.name !== 'enter') return;
    const item = this.st.sessionPicker.items[this.st.sessionPicker.index];
    if (!item || item.current) return this.closeSessions();
    this.closeSessions();
    this.st.busy = true;
    this.toast('opening saved conversation', 'info');
    void this.backend.switchSession(item.path).catch((error) => {
      this.st.busy = false;
      this.onBackendEvent({ type: 'error', error: String(error?.message ?? error) });
    });
  },
};
