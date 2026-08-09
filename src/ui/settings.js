// Settings — a full page in the same brutalist idiom as /status: full-bleed pitch
// masthead, numbered sections, dotted-leader rows, and one spring-driven selection
// bar that glides between them. The page still pushes in from the right. An
// inspector strip at the foot explains whichever row the cursor is on, so no row
// has to carry its own paragraph of help text.

import { ATTR_BOLD, ATTR_DIM, DEFAULT, strWidth } from '../ansi.js';
import { BLOCK, HEAVY, MARK } from '../glyphs.js';
import { T, mix, drawPaperGrain } from '../theme.js';
import { ease, clamp } from '../anim.js';
import { crops, textReveal } from '../draw.js';
import { ellipsize } from '../wrap.js';
import { settingsModel, settingsRows } from '../settings.js';

/**
 * Draw the settings page. Progress comes from `st.settingsAnim`; `st.settingsCursor`
 * is the fractional row the selection bar rides; `st.settingsFlash` pulses the row
 * that just changed value.
 */
export function drawSettings(s, st, t) {
  const { w, h } = s;
  const p = clamp(st.settingsAnim.v, 0, 1);
  if (p <= 0.001) return;

  const model = settingsModel(stApp(st));
  const rows = settingsRows(model);
  const reveal = ease.outCubic(p);
  const shift = Math.round((1 - reveal) * Math.min(18, w));

  wash(s, reveal);

  const px = shift + 2;
  const contentW = Math.max(18, Math.min(72, w - px - 3));
  const sel = clamp(Math.trunc(st.settingsIndex) || 0, 0, Math.max(0, rows.length - 1));

  drawMasthead(s, shift, w, p, sel, rows.length, h >= 12);

  const top = h >= 14 ? 4 : 3;
  // Lay the page out as a flat run of lines first — heads, rows, section gaps.
  // Knowing the natural height up front does two things: the inspector can sit
  // just under the last row on a tall terminal instead of stranding a band of
  // blank paper, and a short one can scroll a window over the run rather than
  // silently dropping whichever sections fell off the bottom.
  const lines = [];
  let idx = 0;
  for (let si = 0; si < model.length; si++) {
    if (si) lines.push({ kind: 'gap' });
    // `at` is the row index this head introduces — the stagger clock counts
    // interactive rows, so heads must be timed against that, not their line.
    lines.push({ kind: 'head', si, sec: model[si], at: idx });
    for (const item of model[si].items) lines.push({ kind: 'row', item, i: idx++ });
  }

  const inspectorY = Math.min(h - 4, top + lines.length + 1);
  const limit = inspectorY - 1;
  const view = Math.max(1, limit - top);
  const selLine = lines.findIndex((l) => l.kind === 'row' && l.i === sel);
  let scroll = lines.length > view
    ? clamp(selLine - Math.floor(view / 2), 0, lines.length - view)
    : 0;
  // Never open the window on a gap or a stranded row: back up onto the head above
  // so a scrolled page still starts with a titled section. Only snap as far as
  // keeps the selected row on screen — a visible cursor outranks a tidy top edge.
  for (let back = scroll; back > 0; back--) {
    if (lines[back].kind === 'head' && selLine - back < view) { scroll = back; break; }
  }

  const rowY = [];
  let y = top;
  let last = top;
  for (let li = scroll; li < lines.length && y < limit; li++) {
    const line = lines[li];
    if (line.kind === 'gap') { y += 1; continue; }
    if (line.kind === 'head') {
      const secP = clamp((p * (rows.length + 3) - line.at) / 2, 0, 1);
      if (secP > 0.02) {
        sectionHead(s, px, y, contentW, `${pad2(line.si + 1)} ${line.sec.title}`,
          String(line.sec.items.length), secP);
      }
    } else {
      rowY[line.i] = y;
      // Per-row stagger: rows arrive in reading order rather than all at once.
      const rp = clamp((p * (rows.length + 3) - line.i) / 1.6, 0, 1);
      if (rp > 0.02) drawRow(s, st, line.item, px, y, contentW, line.i, line.i === sel, rp);
    }
    last = y;
    y += 1;
  }

  // Left-gutter carets, so a scrolled list never reads as the whole list. They
  // ride the same column as the selection bar, clear of the value affordances.
  const cue = mix(T.bg, mix(T.accent, T.slate, 0.4), 0.9 * p);
  if (scroll > 0) s.put(px - 2, top, MARK.tri_u, cue, DEFAULT, ATTR_BOLD);
  if (scroll + view < lines.length) s.put(px - 2, last, MARK.tri_d, cue, DEFAULT, ATTR_BOLD);

  // One spring drives the bar between rows, so it reads as a single object moving
  // rather than a highlight being repainted on a new line.
  const barY = interpRow(rowY, st.settingsCursor.v);
  if (barY >= top && barY < limit && p > 0.3) {
    const k = clamp((p - 0.3) / 0.7, 0, 1);
    const pulse = st.reduceMotion ? 1 : 0.84 + 0.16 * Math.sin(t * 3);
    const col = mix(T.bg, T.accent, k * pulse);
    s.put(px - 2, barY, BLOCK.full, col, DEFAULT, ATTR_BOLD);
    s.put(px - 1, barY, MARK.tri_r, col, DEFAULT, ATTR_BOLD);
  }

  if (p > 0.6) {
    crops(s, px, top - 1, contentW, last - top + 2, mix(T.bg, T.sand, (p - 0.6) / 0.4));
  }

  drawInspector(s, rows[sel], px, inspectorY, contentW, p);
  drawFooter(s, st, h - 1, w);
}

/** Flatten the chat behind to bare paper so the page reads as one printed sheet. */
function wash(s, veil) {
  for (let i = 0; i < s.ch.length; i++) {
    s.ch[i] = ' ';
    s.copyCh[i] = ' ';
    s.at[i] = 0;
    s.fg[i] = T.fg;
    s.bg[i] = mix(s.bg[i] === DEFAULT ? T.bg : s.bg[i], T.bg, veil);
  }
  drawPaperGrain(s);
}

function drawMasthead(s, x, w, p, sel, count, shadow) {
  s.fillRect(0, 0, w, 1, ' ', T.cream, T.pitch);

  const close = ` ESC ${MARK.cross} `;
  const closeX = Math.max(0, w - strWidth(close));
  const counter = `${pad2(sel + 1)}/${pad2(count)}`;
  const counterX = Math.max(0, closeX - strWidth(counter) - 2);

  const title = ' S E T T I N G S ';
  const titleW = Math.min(strWidth(title), Math.max(0, counterX - x));
  if (titleW > 0) {
    s.fillRect(x, 0, titleW, 1, ' ', T.bg, T.accent);
    textReveal(s, x, 0, title, p, T.pitch, T.accent, ATTR_BOLD, titleW);
  }

  // Diagonal hatch fills the gap so the masthead never reads as one dead bar.
  for (let hx = x + titleW + 1; hx < counterX - 1; hx++) {
    s.put(hx, 0, '╱', mix(T.pitch, T.sand, 0.3), T.pitch);
  }
  if (counterX > x + titleW) {
    s.text(counterX, 0, counter, mix(T.pitch, T.sand, 0.92), T.pitch, ATTR_BOLD);
  }
  s.text(closeX, 0, close, T.pitch, T.sand, ATTR_BOLD);

  if (shadow) s.fillRect(2, 1, Math.max(0, w - 2), 1, BLOCK.top, mix(T.bg, T.shadow, 0.32), T.bg);
}

/** Numbered section rule with the item count tagged at the right edge. */
function sectionHead(s, x, y, w, title, tag, k) {
  const shown = ellipsize(title, w);
  let cx = x + s.text(x, y, shown, mix(T.bg, T.fg, k), DEFAULT, ATTR_BOLD, w) + 1;
  const tagW = tag ? strWidth(tag) + 2 : 0;
  for (; cx < x + w - tagW - 1; cx++) s.put(cx, y, HEAVY.h, mix(T.bg, T.rule, k * 0.85));
  if (tag && tagW + 6 < w) {
    s.textRight(x + w - 1, y, ` ${tag} `, T.bg, mix(T.bg, T.slate, k), ATTR_BOLD);
  }
}

/**
 * One row: index, label, dotted leader, value. The leader is what lets a short
 * label and a long value sit on the same line without a box around either.
 */
function drawRow(s, st, item, x, y, w, i, sel, p) {
  const flash = sel ? clamp(st.settingsFlash.v, 0, 1) : 0;
  const rowBg = sel ? mix(T.bg, T.inset, 0.62 * p) : DEFAULT;
  if (sel) s.fillRect(x, y, w, 1, ' ', T.fg, rowBg);

  const numCol = sel ? mix(rowBg, T.accent, p) : mix(T.bg, T.dim, p * 0.85);
  let cx = x + 1 + s.text(x + 1, y, pad2(i + 1), numCol, rowBg, ATTR_BOLD) + 1;

  const labelCol = sel ? mix(rowBg, T.fg, p) : mix(T.bg, T.slate, p);
  const labelW = Math.max(6, Math.floor(w * 0.5));
  cx += s.text(cx, y, ellipsize(item.label, labelW), labelCol, rowBg, sel ? ATTR_BOLD : 0, labelW);

  const valueX = valueCells(s, st, item, x, y, w, sel, p, flash, rowBg);
  // Stop two cells short: the leader is a guide, not a rule butting into the value.
  for (let dot = cx + 1; dot < valueX - 2; dot++) {
    s.put(dot, y, MARK.dot, mix(sel ? rowBg : T.bg, T.rule, 0.85), rowBg);
  }
}

/** Draw a row's value affordance at the right edge; returns its leftmost column. */
function valueCells(s, st, item, x, y, w, sel, p, flash, rowBg) {
  const rx = x + w - 1;
  if (item.type === 'toggle') {
    const on = item.get();
    const chip = on ? ' ON ' : ' OFF ';
    const bg = on ? mix(rowBg === DEFAULT ? T.bg : rowBg, T.accent, 0.86 - flash * 0.3)
      : mix(rowBg === DEFAULT ? T.bg : rowBg, T.inset, 0.9);
    const fg = on ? T.bg : mix(T.bg, T.dim, 0.9);
    s.textRight(rx, y, chip, fg, bg, ATTR_BOLD);
    // A pip track beside the chip states the binary without reading the word.
    const pipX = rx - strWidth(chip) - 3;
    if (pipX > x + 8) {
      s.put(pipX, y, on ? MARK.sq_o : MARK.sq, mix(T.bg, T.dim, on ? 0.5 : 0.95), rowBg);
      s.put(pipX + 1, y, on ? MARK.sq : MARK.sq_o, on ? mix(T.bg, T.accent, 0.95) : mix(T.bg, T.dim, 0.5), rowBg);
      return pipX;
    }
    return rx - strWidth(chip) + 1;
  }

  if (item.type === 'select') {
    const i = item.get();
    const label = String(item.options[i] ?? '?');
    const shown = ellipsize(label, Math.max(4, Math.floor(w * 0.34)));
    const arrows = sel ? mix(T.bg, T.accent, p) : mix(T.bg, T.dim, p * 0.7);
    const valCol = mix(sel ? mix(T.accent, T.fg, 0.32) : T.slate, T.fg, flash);
    const vx = rx - strWidth(shown) - 3;
    let left = vx;
    if (item.swatch) {
      s.put(vx - 2, y, BLOCK.full, mix(T.bg, item.swatch[i] ?? T.accent, p), rowBg);
      left = vx - 2;
    }
    s.text(vx, y, MARK.tri_l, arrows, rowBg, ATTR_BOLD);
    s.text(vx + 2, y, shown, valCol, rowBg, sel ? ATTR_BOLD : 0);
    s.text(rx, y, MARK.tri_r, arrows, rowBg, ATTR_BOLD);
    // Position dots: which option of how many, without spelling out the list.
    const dots = item.options.length;
    if (dots > 1 && dots <= 8 && left - 3 - dots > x + 10) {
      for (let d = 0; d < dots; d++) {
        // Rings, not dots — a dot here would read as more dotted leader.
        s.put(left - 3 - (dots - d), y, d === i ? MARK.sq : MARK.ring,
          d === i ? mix(T.bg, sel ? T.accent : T.slate, 0.95) : mix(T.bg, T.rule, 0.9), rowBg);
      }
      left = left - 3 - dots;
    }
    return left;
  }

  const chip = ` ${MARK.arrow} RUN `;
  const base = rowBg === DEFAULT ? T.bg : rowBg;
  s.textRight(rx, y, chip, sel ? T.bg : mix(T.bg, T.dim, 0.9),
    mix(base, sel ? T.accent2 : T.inset, sel ? 0.86 : 0.72), sel ? ATTR_BOLD : ATTR_DIM);
  return rx - strWidth(chip) + 1;
}

/**
 * Inspector strip: a heavy rule with tee end-caps, the selected row's key as a
 * slug, and its hint. Explaining one row at a time keeps the list itself terse.
 */
function drawInspector(s, item, x, y, w, p) {
  if (!item || y + 1 >= s.h - 1 || p < 0.5) return;
  const k = clamp((p - 0.5) / 0.5, 0, 1);
  for (let i = 0; i < w; i++) s.put(x + i, y, HEAVY.h, mix(T.bg, mix(T.rule, T.accent, 0.32), k));
  s.put(x, y, HEAVY.tee_r, mix(T.bg, mix(T.rule, T.accent, 0.7), k));
  s.put(x + w - 1, y, HEAVY.tee_l, mix(T.bg, mix(T.rule, T.accent, 0.7), k));

  const slug = String(item.key || '').toUpperCase();
  const tag = ` ${ellipsize(slug, Math.max(4, Math.floor(w * 0.3)))} `;
  const used = s.text(x, y + 1, tag, T.bg, mix(T.bg, T.slate, k), ATTR_BOLD);
  const hint = item.hint || typeLabel(item);
  const room = Math.max(0, w - used - 2);
  if (room > 8) s.text(x + used + 1, y + 1, ellipsize(hint, room), mix(T.bg, T.dim, k), DEFAULT, ATTR_DIM, room);
}

function typeLabel(item) {
  if (item.type === 'toggle') return 'Toggle with ↵ or ←→.';
  if (item.type === 'select') return 'Cycle the value with ←→.';
  return 'Run with ↵.';
}

function drawFooter(s, st, y, w) {
  s.fillRect(0, y, w, 1, ' ', T.cream, T.pitch);
  s.put(0, y, BLOCK.full, T.accent, T.pitch);
  let x = 2;
  for (const [key, label] of [['↑↓', 'move'], ['←→', 'change'], ['↵', 'apply'], ['esc', 'back']]) {
    if (x + strWidth(key) + strWidth(label) + 5 > w - 12) break;
    x += s.text(x, y, ` ${key} `, T.pitch, mix(T.pitch, T.cream, 0.84), ATTR_BOLD);
    x += s.text(x, y, ` ${label}`, mix(T.pitch, T.cream, 0.62), T.pitch, 0) + 2;
  }
  const trail = `${MARK.diamond} ${st.cwd || ''}`;
  if (w - x - 2 > 8) {
    s.textRight(w - 2, y, ellipsize(trail, w - x - 2), mix(T.pitch, T.sand, 0.82), T.pitch, ATTR_DIM);
  }
}

/** Map a fractional interactive index onto a screen row via its neighbours. */
function interpRow(rowY, cursor) {
  const lo = Math.floor(cursor);
  const hi = Math.ceil(cursor);
  if (rowY[lo] == null && rowY[hi] == null) return -1;
  if (rowY[lo] == null) return rowY[hi];
  if (rowY[hi] == null) return rowY[lo];
  return Math.round(rowY[lo] + (rowY[hi] - rowY[lo]) * (cursor - lo));
}

function pad2(value) {
  return String(Math.trunc(Number(value) || 0)).padStart(2, '0');
}

// The model builder wants the app, not just state; app stashes a back-reference so
// the pure-ish view can rebuild the model each frame without app plumbing.
function stApp(st) {
  return st._app;
}
