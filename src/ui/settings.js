// Settings — a full page, not an overlay. It pushes in from the right over the
// chat view, staggers its rows in, and rides one spring-driven selection bar that
// glides between rows. The chrome stays blunt; the motion does the softening.

import { ATTR_BOLD, ATTR_DIM, DEFAULT, strWidth } from '../ansi.js';
import { BLOCK, MARK, HEAVY, LIGHT } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { ease, clamp, norm } from '../anim.js';
import { rule, ruleFade, crops } from '../draw.js';
import { ellipsize, padTo } from '../wrap.js';
import { settingsModel, settingsRows, ACCENTS } from '../settings.js';

/**
 * Draw the settings page. `p` 0..1 is the enter/exit progress from a spring in
 * app state; `cursor` is the animated row the selection bar sits on; `sel` is the
 * integer index actually selected; `flash` 0..1 pulses the row that just changed.
 */
export function drawSettings(s, st, t) {
  const { w, h } = s;
  const p = clamp(st.settingsAnim.v, 0, 1);
  if (p <= 0.001) return;

  const model = settingsModel(stApp(st));
  const rows = settingsRows(model);

  // push-in: the whole page slides from the right, so it reads as a layer sliding
  // over the chat rather than a repaint. Grain is preserved by clear() upstream.
  const slide = Math.round((1 - ease.outCubic(p)) * Math.min(24, w));
  const px = 2 + slide;

  // dim + wash the chat behind, grain-safe
  const k = p * 0.9;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      s.bg[i] = mix(s.bg[i] === -1 ? T.bg : s.bg[i], T.bg, k * 0.85);
      s.ch[i] = ' ';
      s.at[i] = 0;
    }
  }

  const contentW = Math.min(64, w - px - 3);

  // --- title slab ---
  const ty = 1;
  const slabW = Math.round(Math.min(contentW, 12) * ease.outExpo(p));
  if (slabW > 1) {
    s.fillRect(px, ty, slabW, 1, ' ', T.bg, T.fg);
    s.text(px + 1, ty, ellipsize('SETTINGS', slabW - 2), T.bg, T.fg, ATTR_BOLD);
  }
  // esc hint parked at the right edge of the content column
  const escHint = 'esc ← back';
  if (contentW > 24) {
    s.text(px + contentW - strWidth(escHint), ty, escHint, mix(T.bg, T.dim, p), DEFAULT, ATTR_DIM);
  }
  ruleFade(s, px, ty + 1, Math.round(contentW * ease.outQuint(p)), T.rule, T.bg, 1);

  // --- rows, grouped by section ---
  let y = ty + 3;
  let rowIndex = 0;
  const cursorRow = st.settingsCursor.v; // fractional, spring-driven
  const rowY = []; // screen row per interactive index, for the selection bar

  for (const sec of model) {
    // section header: dim label with a hairline running out to the edge
    const secP = clamp((p * (rows.length + 3) - rowIndex) / 2, 0, 1);
    if (secP > 0.02 && y < h - 2) {
      s.text(px, y, sec.title, mix(T.bg, T.dim, secP), DEFAULT, ATTR_BOLD | ATTR_DIM);
      const from = px + strWidth(sec.title) + 1;
      const to = px + contentW;
      for (let i = from; i < to; i++) {
        s.put(i, y, LIGHT.h, mix(T.bg, T.rule, secP * 0.4 * (1 - (i - from) / Math.max(1, to - from))));
      }
    }
    y += 1;

    for (const it of sec.items) {
      const idx = rowIndex++;
      rowY[idx] = y;
      const rp = clamp((p * (rows.length + 3) - idx) / 1.6, 0, 1); // per-row stagger
      if (rp > 0.02 && y < h - 2) drawRow(s, st, it, px, y, contentW, idx === st.settingsIndex, rp, t);
      y += 1;
    }
    y += 1;
  }

  // --- the selection bar: one spring glides it between rows ---
  const barY = rowY[0] != null ? Math.round(rowY[0] + (cursorRow - 0) * 1) : -1;
  // cursorRow is an interactive-index-space value; map it to a screen row by
  // interpolating between the two rows it sits between so the bar tracks smoothly
  const drawY = interpRow(rowY, cursorRow);
  if (drawY >= 0 && p > 0.3) {
    const barCol = mix(T.bg, T.accent, clamp((p - 0.3) / 0.7, 0, 1));
    s.put(px - 1, drawY, BLOCK.full, barCol, DEFAULT, ATTR_BOLD);
    s.put(px - 2, drawY, MARK.tri_r, barCol, DEFAULT, ATTR_BOLD);
  }

  // corner crop marks around the content column — the precise detail against the slab
  if (p > 0.6) {
    crops(s, px, ty, contentW, y - ty - 1, mix(T.bg, T.sand, (p - 0.6) / 0.4));
  }

  // footer hints
  const fy = h - 1;
  const foot = ' ↑↓ move   ←→ change   ↵ toggle/run   esc back ';
  if (p > 0.5 && strWidth(foot) < w) {
    s.fillRect(0, fy, w, 1, ' ', T.dim, T.bg);
    s.text(1, fy, foot, mix(T.bg, T.dim, p), DEFAULT, ATTR_DIM);
  }
}

function drawRow(s, st, it, x, y, w, sel, p, t) {
  const flash = sel ? clamp(st.settingsFlash.v, 0, 1) : 0;
  const rowBg = sel ? mix(T.bg, T.inset, 0.6 * p) : T.bg;
  s.fillRect(x, y, w, 1, ' ', T.fg, rowBg);

  const labelCol = sel ? mix(T.bg, T.fg, p) : mix(T.bg, T.slate, p);
  s.text(x + 1, y, ellipsize(it.label, Math.floor(w * 0.55)), labelCol, rowBg, sel ? ATTR_BOLD : 0);

  const rx = x + w - 1;
  if (it.type === 'toggle') {
    const on = it.get();
    const chip = on ? ' ON ' : ' OFF ';
    const bg = on ? mix(rowBg, T.accent, 0.85 - flash * 0.3) : mix(rowBg, T.inset, 0.9);
    const fg = on ? T.bg : mix(rowBg, T.dim, 0.9);
    s.textRight(rx, y, chip, fg, bg, ATTR_BOLD);
  } else if (it.type === 'select') {
    const i = it.get();
    const label = it.options[i] ?? '?';
    // swatch dot for the accent picker: the value carries its own colour
    let tail = `${MARK.tri_r} `;
    let head = ` ${MARK.tri_l}`;
    const val = `‹${head}${label}${tail}›`.replace(`${head}`, '').replace(`${tail}`, label ? ` ${label} ` : '');
    const shown = `‹ ${label} ›`;
    const valCol = mix(rowBg, sel ? mix(T.accent, T.fg, 0.3) : T.slate, p);
    let vx = rx - strWidth(shown) + 1;
    if (it.swatch) {
      const sw = it.swatch[i] ?? T.accent;
      s.put(vx - 2, y, BLOCK.full, mix(rowBg, sw, p), rowBg);
    }
    // ‹ and › tint into the accent while selected so the arrows read as live
    s.text(vx, y, '‹', mix(rowBg, sel ? T.accent : T.dim, p), rowBg, ATTR_BOLD);
    s.text(vx + 2, y, label, mix(valCol, T.fg, flash), rowBg, sel ? ATTR_BOLD : 0);
    s.text(vx + 2 + strWidth(label) + 1, y, '›', mix(rowBg, sel ? T.accent : T.dim, p), rowBg, ATTR_BOLD);
  } else if (it.type === 'action') {
    const chip = ` ${MARK.arrow} run `;
    const bg = mix(rowBg, sel ? T.accent2 : T.inset, sel ? 0.85 : 0.7);
    const fg = sel ? T.bg : mix(rowBg, T.dim, 0.9);
    s.textRight(rx, y, chip, fg, bg, sel ? ATTR_BOLD : ATTR_DIM);
  }
}

/** Map a fractional interactive index onto a screen row via its neighbours. */
function interpRow(rowY, cursor) {
  const lo = Math.floor(cursor);
  const hi = Math.ceil(cursor);
  if (rowY[lo] == null && rowY[hi] == null) return -1;
  if (rowY[lo] == null) return rowY[hi];
  if (rowY[hi] == null) return rowY[lo];
  const f = cursor - lo;
  return Math.round(rowY[lo] + (rowY[hi] - rowY[lo]) * f);
}

// The model builder wants the app, not just state; app stashes a back-reference so
// the pure-ish view can rebuild the model each frame without app plumbing.
function stApp(st) {
  return st._app;
}
