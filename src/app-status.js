import { clamp } from './anim.js';
import { recordUsage } from './usage-history.js';

const PAGES = 4;

export const statusMethods = {
  openStatus(page = 0) {
    const status = this.st.status;
    status.open = true;
    status.page = clamp(Number(page) || 0, 0, PAGES - 1);
    status.anim.set(1, this.st.reduceMotion);
    this.s.invalidate();
    return true;
  },

  closeStatus() {
    const status = this.st.status;
    status.open = false;
    status.hits = [];
    status.anim.set(0, this.st.reduceMotion);
    this.s.invalidate();
    return true;
  },

  cycleStatusPage(offset = 1) {
    const status = this.st.status;
    status.page = (status.page + Number(offset) + PAGES) % PAGES;
    status.pulse.set(1, true);
    status.pulse.set(0);
    this.s.invalidate();
    return status.page;
  },

  statusKey(key) {
    const name = String(key?.name ?? '').toLowerCase();
    if (name === 'escape') return this.closeStatus();
    if (name === 'tab' || name === 'right' || name === 'down') return this.cycleStatusPage(1);
    if (name === 'left' || name === 'up') return this.cycleStatusPage(-1);
    if (/^[1-4]$/.test(name)) {
      this.st.status.page = Number(name) - 1;
      this.s.invalidate();
      return true;
    }
    if (name === 'u') {
      void this.checkForUpdates({ force: true });
      return true;
    }
    return true;
  },

  statusPointer(x, y) {
    const hit = [...(this.st.status.hits ?? [])].reverse().find((item) =>
      y === item.y && x >= item.x1 && x <= item.x2);
    if (!hit) return true;
    if (hit.kind === 'page') {
      this.st.status.page = hit.page;
      this.s.invalidate();
      return true;
    }
    if (hit.kind === 'update') {
      void this.checkForUpdates({ force: true });
      return true;
    }
    if (hit.kind === 'close') return this.closeStatus();
    return true;
  },

  recordUsageEvent(event) {
    const current = this.st.conversationUsage;
    current.input += usageValue(event.inputTokens ?? event.input);
    current.output += usageValue(event.outputTokens ?? event.output);
    current.cacheRead += usageValue(event.cacheReadTokens ?? event.cacheRead ?? event.cache);
    current.cacheWrite += usageValue(event.cacheWriteTokens ?? event.cacheWrite);
    current.cost += usageValue(event.cost);
    recordUsage(this.st.usageHistory, {
      ...event,
      model: event.model || this.st.model,
      effort: event.effort || this.st.effort || 'default',
    });
    this.persistPreferences();
    this.s.invalidate();
  },

};

function usageValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
