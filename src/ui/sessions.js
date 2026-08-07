// Saved conversation overlay.

import { ATTR_BOLD, ATTR_DIM, DEFAULT, strWidth } from '../ansi.js';
import { BLOCK, HEAVY, MARK } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { ease, clamp } from '../anim.js';
import { panel } from '../draw.js';
import { ellipsize } from '../wrap.js';
import { SESSION_ROWS } from '../sessions.js';

export function drawSessions(s, st) {
  const picker = st.sessionPicker;
  const p = clamp(picker.anim.v, 0, 1);
  if (p <= 0.001) return;
  const rows = Math.max(1, Math.min(SESSION_ROWS, picker.items.length || 1, Math.max(1, s.h - 4)));
  const w = Math.max(2, Math.min(76, s.w >= 8 ? s.w - 4 : s.w));
  const h = Math.min(s.h, rows + 4);
  const x = Math.max(0, Math.floor((s.w - w) / 2));
  const restingY = Math.max(1, Math.floor((s.h - h) / 2) - 1);
  const y = clamp(restingY + Math.round((1 - ease.outBack(p)) * 5), 0, Math.max(0, s.h - h));

  for (let sy = 0; sy < s.h; sy++) for (let sx = 0; sx < s.w; sx++) {
    const i = sy * s.w + sx;
    s.bg[i] = mix(s.bg[i] === DEFAULT ? T.bg : s.bg[i], T.shadow, p * 0.28);
    s.fg[i] = mix(s.fg[i] === DEFAULT ? T.fg : s.fg[i], T.shadow, p * 0.22);
  }
  panel(s, x, y, w, h, { bg: T.panel, border: T.fg, style: HEAVY, shadow: true, label: 'CONVERSATIONS' });
  if (w < 28 || h < 5) {
    s.text(x + 1, y + Math.min(1, h - 1), ellipsize('CONVERSATIONS', Math.max(1, w - 2)), T.fg, T.panel, ATTR_BOLD);
    return;
  }
  const count = ` ${picker.items.length} saved `;
  if (strWidth(count) + 18 < w) s.textRight(x + w - 2, y, count, T.dim, T.panel, ATTR_DIM);
  s.text(x + 2, y + 1, picker.loading ? 'loading auto-saved sessions…' : '↑↓ choose  ·  enter return', T.dim, T.panel, ATTR_DIM, w - 4);

  const view = picker.items.slice(picker.scroll, picker.scroll + rows);
  if (!picker.loading && !view.length) s.text(x + 3, y + 2, 'No saved conversation yet', T.dim, T.panel, ATTR_DIM);
  for (let i = 0; i < view.length; i++) {
    const item = view[i];
    const index = picker.scroll + i;
    const selected = index === picker.index;
    const ry = y + 2 + i;
    const bg = selected ? T.fg : T.panel;
    const fg = selected ? T.bg : T.fg;
    s.fillRect(x + 1, ry, w - 2, 1, ' ', fg, bg);
    if (selected) s.put(x + 1, ry, MARK.tri_r, T.accent, bg, ATTR_BOLD);
    const stamp = item.modifiedLabel || '';
    const right = item.current ? 'current' : `${item.messageCount} msg${item.messageCount === 1 ? '' : 's'}`;
    const rightW = strWidth(right);
    const titleW = Math.max(8, w - rightW - strWidth(stamp) - 10);
    s.text(x + 3, ry, ellipsize(item.title, titleW), fg, bg, selected ? ATTR_BOLD : 0, titleW);
    if (stamp) s.text(x + 4 + titleW, ry, stamp, selected ? mix(T.fg, T.bg, 0.65) : T.dim, bg, ATTR_DIM);
    s.textRight(x + w - 3, ry, right, selected ? T.warn : T.dim, bg, item.current ? ATTR_BOLD : ATTR_DIM);
  }
  const footer = ' esc close   auto-save is always on ';
  if (strWidth(footer) + 3 < w) s.text(x + 2, y + h - 1, footer, T.dim, T.panel, ATTR_DIM);

  if (picker.items.length > rows) {
    const pos = Math.round((picker.index / Math.max(1, picker.items.length - 1)) * (rows - 1));
    for (let i = 0; i < rows; i++) s.put(x + w - 2, y + 2 + i, i === pos ? BLOCK.full : BLOCK.l1, i === pos ? T.accent : T.rule, T.panel);
  }
}
