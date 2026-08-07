// Palette, settings and jump-list controllers. These overlays share modal list
// mechanics, so they live together instead of expanding the main app shell.

import { clamp } from './anim.js';
import { filterCommands, paletteLayout } from './ui/palette.js';
import { settingsRows, settingsModel, applySetting } from './settings.js';
import { jumpResults, jumpLabel, jumpLayout, JUMP_ROWS } from './ui/jumplist.js';
import { layout as transcriptLayout, visibleLines as transcriptVisibleLines } from './ui/transcript.js';

export const navigationMethods = {
  openPalette() {
    this.st.palette = true;
    this.st.paletteQuery = '';
    this.st.paletteIndex = 0;
    this.st.paletteScroll = 0;
    this.st.paletteResults = filterCommands(this.cmds.filter((command) => command.palette), '');
    this.st.paletteAnim.set(1);
  },
  closePalette() { this.st.palette = false; this.st.paletteAnim.set(0); },
  paletteKey(k) {
    if (k.name === 'escape' || (k.ctrl && k.name === 'p')) return this.closePalette();
    if (k.name === 'enter') {
      const it = this.st.paletteResults[this.st.paletteIndex];
      this.closePalette();
      if (it) this.later(() => it.run(), 90);
      return;
    }
    if (k.name === 'up' || (k.ctrl && k.name === 'k')) return this.paletteMove(-1);
    if (k.name === 'down' || (k.ctrl && k.name === 'n')) return this.paletteMove(1);
    if (k.name === 'pageup') return this.paletteMove(-this.paletteRows());
    if (k.name === 'pagedown') return this.paletteMove(this.paletteRows());
    if (k.name === 'home') return this.paletteSelect(0);
    if (k.name === 'end') return this.paletteSelect(this.st.paletteResults.length - 1);
    if (k.name === 'backspace') {
      this.st.paletteQuery = [...this.st.paletteQuery].slice(0, -1).join('');
      return this.paletteRefilter();
    }
    if (k.name === 'space') { this.st.paletteQuery += ' '; return this.paletteRefilter(); }
    if (k.printable && !k.ctrl && !k.alt) { this.st.paletteQuery += k.name; return this.paletteRefilter(); }
  },
  paletteRefilter() {
    this.st.paletteResults = filterCommands(this.cmds.filter((command) => command.palette), this.st.paletteQuery);
    this.st.paletteIndex = 0;
    this.st.paletteScroll = 0;
  },
  paletteMove(d) {
    const n = this.st.paletteResults.length;
    if (n) return this.paletteSelect((this.st.paletteIndex + d % n + n) % n);
  },
  paletteRows() { return paletteLayout(this.s.w, this.s.h, this.st.paletteResults.length).rows; },
  paletteSelect(index) {
    const n = this.st.paletteResults.length;
    if (!n) return;
    this.st.paletteIndex = clamp(index, 0, n - 1);
    const rows = this.paletteRows();
    if (this.st.paletteIndex < this.st.paletteScroll) this.st.paletteScroll = this.st.paletteIndex;
    if (this.st.paletteIndex >= this.st.paletteScroll + rows) this.st.paletteScroll = this.st.paletteIndex - rows + 1;
  },
  palettePointer(x, y, activate) {
    const n = this.st.paletteResults.length;
    const g = paletteLayout(this.s.w, this.s.h, n, this.st.paletteAnim.v);
    const inside = x >= g.px && x < g.px + g.pw && y >= g.py && y < g.py + g.ph;
    if (!inside) { if (activate) this.closePalette(); return; }
    if (g.compact || y < g.resultY || y >= g.resultY + g.rows) return;
    const index = this.st.paletteScroll + y - g.resultY;
    if (index < 0 || index >= n) return;
    this.paletteSelect(index);
    if (!activate) return;
    const it = this.st.paletteResults[index];
    this.closePalette();
    if (it) this.later(() => it.run(), 90);
  },

  openSettings() {
    if (this.st.palette) this.closePalette();
    this.st.view = 'settings';
    this.st.settingsIndex = 0;
    this.st.settingsCursor.set(0, true);
    this.st.settingsAnim.set(1);
    this.s.invalidate();
  },
  closeSettings() { this.st.view = 'chat'; this.st.settingsAnim.set(0); this.s.invalidate(); },
  settingsKey(k) {
    if (k.name === 'escape' || (k.ctrl && k.name === 'o')) return this.closeSettings();
    const rows = settingsRows(settingsModel(this));
    if (!rows.length) return;
    if (k.name === 'up') return this.settingsMove(-1);
    if (k.name === 'down') return this.settingsMove(1);
    if (k.name === 'left') return this.settingsAdjust(-1);
    if (k.name === 'right') return this.settingsAdjust(1);
    if (k.name === 'enter' || k.name === 'space') {
      const it = rows[this.st.settingsIndex];
      if (it.type === 'toggle') { it.set(!it.get()); this.flashSetting(); }
      else if (it.type === 'action') it.run();
      else this.settingsAdjust(1);
    }
  },
  settingsMove(d) {
    const rows = settingsRows(settingsModel(this));
    this.st.settingsIndex = (this.st.settingsIndex + d + rows.length) % rows.length;
    this.st.settingsCursor.set(this.st.settingsIndex, this.st.reduceMotion);
  },
  settingsAdjust(d) {
    const it = settingsRows(settingsModel(this))[this.st.settingsIndex];
    if (!it) return;
    if (it.type === 'toggle') it.set(!it.get());
    else if (it.type === 'select') it.set((it.get() + d + it.options.length) % it.options.length);
    else return;
    this.flashSetting();
  },
  flashSetting() { this.st.settingsFlash.set(1, true); this.st.settingsFlash.set(0); },
  applyHarnessSetting(key, value) {
    const resolved = applySetting(this, key, value);
    if (this.harness) this.harness.emit({ event: 'setting', key, value: resolved });
  },

  openJump() {
    if (this.st.palette) this.closePalette();
    this.st.jumpQuery = '';
    this.st.jumpDepth = 0;
    this.st.jumpParent = null;
    this.refreshJump();
    if (!this.st.jumpResults.length) return this.toast('nothing to jump to', 'warn');
    this.st.jump = true;
    this.st.jumpIndex = clamp(this.st.jumpResults.length - 1, 0, this.st.jumpResults.length - 1);
    this.clampJumpScroll();
    this.st.jumpAnim.set(1);
  },
  closeJump() {
    this.st.jump = false;
    this.st.jumpAnim.set(0);
    this.st.jumpDepth = 0;
    this.st.jumpParent = null;
  },
  refreshJump() {
    if (this.st.jumpDepth && this.st.jumpParent) {
      const q = this.st.jumpQuery.trim().toLowerCase();
      this.st.jumpResults = (this.st.jumpParent.children ?? []).filter((item) => {
        if (!q) return true;
        const msg = item.msg;
        return `${jumpLabel(msg)} ${msg.name ?? ''} ${msg.meta ?? ''}`.toLowerCase().includes(q);
      });
    } else {
      this.st.jumpResults = jumpResults(this.st.msgs, this.st.jumpQuery);
    }
    this.st.jumpIndex = clamp(this.st.jumpIndex, 0, Math.max(0, this.st.jumpResults.length - 1));
    this.clampJumpScroll();
  },
  clampJumpScroll() {
    const rows = Math.min(JUMP_ROWS, this.st.jumpResults.length);
    if (this.st.jumpIndex < this.st.jumpScroll) this.st.jumpScroll = this.st.jumpIndex;
    else if (this.st.jumpIndex >= this.st.jumpScroll + rows) this.st.jumpScroll = this.st.jumpIndex - rows + 1;
    this.st.jumpScroll = clamp(this.st.jumpScroll, 0, Math.max(0, this.st.jumpResults.length - rows));
  },
  jumpMove(d) {
    const n = this.st.jumpResults.length;
    if (!n) return;
    this.st.jumpIndex = (this.st.jumpIndex + d + n) % n;
    this.clampJumpScroll();
  },
  jumpKey(k) {
    if (k.name === 'escape' || (k.ctrl && k.name === 'g')) return this.closeJump();
    if (k.name === 'left') {
      if (this.st.jumpDepth) {
        this.st.jumpDepth = 0;
        this.st.jumpParent = null;
        this.refreshJump();
      }
      return;
    }
    if (k.name === 'right') {
      const item = this.st.jumpResults[this.st.jumpIndex];
      if (!this.st.jumpDepth && item?.kind === 'work') return this.openJumpChildren(item);
      return;
    }
    if (k.name === 'mousedown' && k.mouse) {
      const layout = jumpLayout(this.s.w, this.s.h, this.st.jumpResults.length, this.st.jumpAnim.v);
      const row = Math.floor(k.y - layout.py - 3) + this.st.jumpScroll;
      if (k.x < layout.px || k.x >= layout.px + layout.pw || row < this.st.jumpScroll
        || row >= this.st.jumpScroll + layout.rows || row >= this.st.jumpResults.length) return;
      this.st.jumpIndex = row;
      return this.jumpToItem(this.st.jumpResults[row]);
    }
    if (k.name === 'wheelup' || k.name === 'up' || (k.ctrl && k.name === 'k')) return this.jumpMove(-1);
    if (k.name === 'wheeldown' || k.name === 'down' || (k.ctrl && k.name === 'n')) return this.jumpMove(1);
    if (k.name === 'enter') {
      const it = this.st.jumpResults[this.st.jumpIndex];
      this.closeJump();
      if (it) this.jumpToItem(it);
      return;
    }
    if (k.name === 'backspace') { this.st.jumpQuery = [...this.st.jumpQuery].slice(0, -1).join(''); return this.refreshJump(); }
    if (k.name === 'space') { this.st.jumpQuery += ' '; return this.refreshJump(); }
    if (k.printable && !k.ctrl && !k.alt) { this.st.jumpQuery += k.name; return this.refreshJump(); }
  },
  openJumpChildren(item) {
    if (!item?.children?.length) return this.toast('this work item has no child tools', 'info');
    this.st.jumpDepth = 1;
    this.st.jumpParent = item;
    this.st.jumpQuery = '';
    this.st.jumpIndex = 0;
    this.st.jumpScroll = 0;
    this.refreshJump();
  },
  jumpToItem(item) {
    if (!item) return;
    if (item.kind === 'tool' && item.childIndex >= 0) {
      const group = this.st.msgs[item.index];
      const container = group?.role === 'workgroup' ? group : null;
      const toolGroup = container ? (item.group ?? container.tools?.[0]) : group;
      if (toolGroup?.role === 'toolgroup') {
        if (container) {
          container.expanded = true;
          container.expandAnim?.set(1, true);
        }
        toolGroup.expanded = true;
        toolGroup.expandAnim?.set(1, true);
        const rows = container ? transcriptVisibleLines(group, this.bodyWidth()) : transcriptLayout(group, this.bodyWidth());
        let child = -1;
        let seen = 0;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].kind !== 'toolchildhead') continue;
          if (rows[i].tool?.callId === item.msg?.callId || seen++ === item.childIndex) { child = i; break; }
        }
        return this.jumpToMessageRow(item.index, Math.max(0, child));
      }
    }
    this.jumpToMessage(item.index);
  },
};
