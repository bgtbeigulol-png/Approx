// Brutalist directory-browser overlay. Geometry is exported for exact pointer hits.

import { ATTR_BOLD, ATTR_DIM, DEFAULT, strWidth } from '../ansi.js';
import { BLOCK, HEAVY, MARK, SPIN_BLOCK } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { ease, clamp } from '../anim.js';
import { panel } from '../draw.js';
import { ellipsize } from '../wrap.js';

export const DIRECTORY_ROWS = 10;

export function directoryLayout(screenWidth, screenHeight, itemCount, progress = 1) {
  const sw = Math.max(1, Number(screenWidth) || 1);
  const sh = Math.max(1, Number(screenHeight) || 1);
  const pw = Math.max(1, Math.min(86, sw >= 6 ? sw - 4 : sw));
  const availableRows = Math.max(1, sh - 5);
  const rows = Math.max(1, Math.min(DIRECTORY_ROWS, itemCount || 1, availableRows));
  const ph = Math.min(sh, rows + 5);
  const px = Math.max(0, Math.floor((sw - pw) / 2));
  const restY = Math.max(0, Math.floor((sh - ph) / 2) - 1);
  const p = clamp(progress, 0, 1);
  const py = clamp(restY + Math.round((1 - ease.outBack(p)) * 5), 0, Math.max(0, sh - ph));
  return {
    px, py, pw, ph, rows,
    hintY: py + 1,
    pathY: py + Math.min(2, ph - 1),
    headY: py + Math.min(3, ph - 1),
    resultY: py + Math.min(4, ph - 1),
  };
}

export function directoryHit(layout, x, y, scroll = 0, itemCount = Infinity) {
  if (!layout || x < layout.px || x >= layout.px + layout.pw
    || y < layout.resultY || y >= layout.resultY + layout.rows) return -1;
  const index = scroll + y - layout.resultY;
  return index >= 0 && index < itemCount ? index : -1;
}

export function drawDirectories(s, st, t = 0) {
  const picker = st.directoryPicker;
  if (!picker) return;
  const p = clamp(picker.anim.v, 0, 1);
  if (p <= 0.001) return;
  s.clearCursorAnchor();
  const g = directoryLayout(s.w, s.h, picker.items.length, p);

  for (let sy = 0; sy < s.h; sy++) for (let sx = 0; sx < s.w; sx++) {
    const i = sy * s.w + sx;
    s.bg[i] = mix(s.bg[i] === DEFAULT ? T.bg : s.bg[i], T.shadow, p * 0.34);
    s.fg[i] = mix(s.fg[i] === DEFAULT ? T.fg : s.fg[i], T.shadow, p * 0.25);
  }

  panel(s, g.px, g.py, g.pw, g.ph, {
    bg: T.panel, border: T.fg, style: HEAVY, shadow: true, label: 'OPEN FOLDER // /CD',
  });
  if (g.pw < 26 || g.ph < 5) {
    s.text(g.px + 1, g.py + Math.min(1, g.ph - 1), ellipsize('OPEN FOLDER', Math.max(1, g.pw - 2)), T.fg, T.panel, ATTR_BOLD);
    return;
  }

  const spinner = SPIN_BLOCK[Math.floor(t * 11) % SPIN_BLOCK.length];
  const status = picker.switching
    ? `${spinner} SWITCHING WORKSPACE`
    : picker.loading
      ? `${spinner} READING DIRECTORY`
      : `${picker.items.length} ENTRIES`;
  const statusColor = picker.switching ? T.warn : picker.loading ? T.accent : T.dim;
  if (strWidth(status) + 24 < g.pw) s.textRight(g.px + g.pw - 2, g.py, ` ${status} `, statusColor, T.panel, picker.loading || picker.switching ? ATTR_BOLD : ATTR_DIM);

  const hint = picker.editingPath
    ? 'TYPE LOCATION  /  ENTER OPEN  /  ESC CANCEL'
    : 'UP/DOWN CHOOSE  /  ENTER OPEN  /  CTRL+L LOCATION';
  if (g.hintY < g.py + g.ph - 1) s.text(g.px + 2, g.hintY, ellipsize(hint, g.pw - 4), T.dim, T.panel, ATTR_DIM, g.pw - 4);

  if (g.pathY < g.py + g.ph - 1) {
    const pathBg = picker.editingPath ? T.fg : mix(T.panel, T.fg, 0.08);
    const pathFg = picker.editingPath ? T.bg : T.fg;
    s.fillRect(g.px + 1, g.pathY, g.pw - 2, 1, ' ', pathFg, pathBg);
    const prefix = picker.editingPath ? 'LOCATION > ' : `${MARK.diamond} `;
    const value = picker.editingPath ? picker.pathInput : picker.path;
    s.text(g.px + 2, g.pathY, prefix, picker.editingPath ? T.accent : T.warn, pathBg, ATTR_BOLD);
    const valueX = g.px + 2 + strWidth(prefix);
    const valueW = Math.max(1, g.px + g.pw - 2 - valueX);
    s.text(valueX, g.pathY, ellipsize(value || 'type a path', valueW), pathFg, pathBg, picker.editingPath ? ATTR_BOLD : 0, valueW);
    if (picker.editingPath) {
      const caretX = Math.min(g.px + g.pw - 3, valueX + strWidth(ellipsize(value, valueW - 1)));
      s.put(caretX, g.pathY, BLOCK.full, T.accent, pathBg);
      s.setCursorAnchor(caretX, g.pathY);
    }
  }

  if (g.headY < g.py + g.ph - 1) {
    s.text(g.px + 2, g.headY, 'KIND', T.dim, T.panel, ATTR_DIM);
    s.text(g.px + 10, g.headY, 'DIRECTORY', T.dim, T.panel, ATTR_DIM);
    s.textRight(g.px + g.pw - 3, g.headY, picker.switching ? 'PLEASE WAIT' : 'ENTER', T.dim, T.panel, ATTR_DIM);
  }

  if (picker.error && !picker.loading) {
    const errorY = Math.min(g.resultY, g.py + g.ph - 2);
    s.text(g.px + 2, errorY, MARK.cross, T.warn, T.panel, ATTR_BOLD);
    s.text(g.px + 4, errorY, ellipsize(picker.error, g.pw - 7), T.warn, T.panel, 0, g.pw - 7);
  } else if (picker.loading && !picker.items.length) {
    const loadY = Math.min(g.resultY, g.py + g.ph - 2);
    s.text(g.px + 2, loadY, `${spinner} scanning folders`, T.accent, T.panel, ATTR_BOLD, g.pw - 4);
  }

  const scroll = clamp(picker.scroll, 0, Math.max(0, picker.items.length - g.rows));
  const view = picker.error && !picker.loading ? [] : picker.items.slice(scroll, scroll + g.rows);
  const travel = Math.round(clamp(picker.travel.v, -1, 1) * 3);
  for (let i = 0; i < view.length; i++) {
    const item = view[i];
    const index = scroll + i;
    const selected = index === picker.index;
    const ry = g.resultY + i;
    if (ry <= g.py || ry >= g.py + g.ph - 1) continue;
    const bg = selected ? T.fg : item.kind === 'select' ? mix(T.panel, T.accent, 0.13) : T.panel;
    const fg = selected ? T.bg : T.fg;
    s.fillRect(g.px + 1, ry, g.pw - 2, 1, ' ', fg, bg);
    if (selected) {
      s.put(g.px + 1, ry, MARK.tri_r, T.accent, bg, ATTR_BOLD);
      const cursorRow = g.resultY + Math.round(picker.cursor.v - scroll);
      if (cursorRow === ry) s.put(g.px + g.pw - 2, ry, BLOCK.full, T.accent, bg, ATTR_BOLD);
    }

    const kind = item.kind === 'select' ? 'OPEN' : item.kind === 'parent' ? 'UP' : item.linked ? 'LINK' : 'DIR';
    const kindColor = selected ? T.warn : item.kind === 'select' ? T.accent : T.dim;
    s.text(g.px + 3, ry, kind.padEnd(4), kindColor, bg, item.kind === 'select' ? ATTR_BOLD : ATTR_DIM, 4);
    const right = item.kind === 'select' ? 'CTRL+ENTER' : item.kind === 'parent' ? MARK.arrow_l : MARK.arrow;
    const nameX = g.px + 10 + travel;
    const nameW = Math.max(4, g.px + g.pw - 5 - strWidth(right) - nameX);
    if (nameX > g.px + 2 && nameX < g.px + g.pw - 3) {
      s.text(nameX, ry, ellipsize(item.label, nameW), fg, bg, selected || item.kind === 'select' ? ATTR_BOLD : 0, nameW);
    }
    s.textRight(g.px + g.pw - 4, ry, right, selected ? T.warn : T.dim, bg, selected ? ATTR_BOLD : ATTR_DIM);
  }

  if (picker.items.length > g.rows) {
    const railX = g.px + g.pw - 2;
    const pos = Math.round((picker.index / Math.max(1, picker.items.length - 1)) * (g.rows - 1));
    for (let i = 0; i < g.rows; i++) {
      const y = g.resultY + i;
      if (y >= g.py + g.ph - 1) break;
      s.put(railX, y, i === pos ? BLOCK.full : BLOCK.l1, i === pos ? T.accent : T.rule, i === pos && picker.index === scroll + i ? T.fg : T.panel);
    }
  }

  // A moving hard-edged scan rides the lower border during async work.
  if (picker.loading || picker.switching) {
    const width = Math.max(1, g.pw - 4);
    const head = Math.floor((t * 24) % width);
    const y = g.py + g.ph - 1;
    for (let i = 0; i < Math.min(7, width); i++) {
      const x = g.px + 2 + (head + i) % width;
      s.put(x, y, i < 3 ? BLOCK.full : BLOCK.shade2, picker.switching ? T.warn : T.accent, T.panel, ATTR_BOLD);
    }
  }
}

export const drawDirectoryPicker = drawDirectories;
