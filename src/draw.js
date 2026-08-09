// Composite drawing helpers built on Screen.

import { DEFAULT, strWidth, charWidth, ATTR_BOLD, ATTR_DIM } from './ansi.js';
import { HEAVY, LIGHT, LEFT_RAMP, UP_RAMP, DENSITY, BLOCK, MARK } from './glyphs.js';
import { T, mix, shade } from './theme.js';
import { clamp } from './anim.js';

/** Hard-cornered box. `style` = HEAVY | LIGHT. */
export function box(s, x, y, w, h, style = HEAVY, fg = T.rule, bg = DEFAULT) {
  if (w < 2 || h < 2) return;
  s.put(x, y, style.tl, fg, bg);
  s.put(x + w - 1, y, style.tr, fg, bg);
  s.put(x, y + h - 1, style.bl, fg, bg);
  s.put(x + w - 1, y + h - 1, style.br, fg, bg);
  for (let i = 1; i < w - 1; i++) {
    s.put(x + i, y, style.h, fg, bg);
    s.put(x + i, y + h - 1, style.h, fg, bg);
  }
  for (let j = 1; j < h - 1; j++) {
    s.put(x, y + j, style.v, fg, bg);
    s.put(x + w - 1, y + j, style.v, fg, bg);
  }
}

/** Filled panel with an offset hard shadow — the brutalist signature. */
export function panel(s, x, y, w, h, {
  bg = T.panel, border = T.rule, style = HEAVY, shadow = true, shadowOff = 1, label = null,
  shadowColor = null, labelColor = T.dim, labelBg = null, fill = true,
} = {}) {
  if (shadow) {
    const sh = shadowColor ?? mix(T.bg, T.shadow, 0.34);
    // Draw one offset rectangle behind the panel. The covered centre disappears
    // under the panel, leaving exactly one L-shaped hard shadow at right/bottom.
    clippedPlate(s, x + shadowOff, y + shadowOff, w, h, sh, sh);
  }
  if (fill) clippedPlate(s, x, y, w, h, T.fg, bg);
  box(s, x, y, w, h, style, border, bg);
  if (label) {
    const lb = labelBg ?? bg;
    const txt = ` ${label} `;
    s.text(x + 2, y, txt, labelColor, lb, ATTR_BOLD, w - 4);
  }
}

/**
 * Clear an overlay footprint without leaking its background one cell outside
 * when the edge cuts through a CJK/emoji wide glyph. The crossing glyph is
 * removed as a whole, while the outside half keeps its original scrim style.
 */
export function clippedPlate(s, x, y, w, h, fg = T.fg, bg = T.bg) {
  const repairs = [];
  const x1 = clamp(x, 0, s.w);
  const x2 = clamp(x + w, 0, s.w);
  const y1 = clamp(y, 0, s.h);
  const y2 = clamp(y + h, 0, s.h);
  if (x2 <= x1 || y2 <= y1) return;

  const capture = (i) => ({ i, fg: s.fg[i], bg: s.bg[i], at: s.at[i] });
  for (let row = y1; row < y2; row++) {
    const base = row * s.w;
    const first = base + x1;
    if (x1 > 0 && s.ch[first] === '') repairs.push(capture(first - 1));
    const last = base + x2 - 1;
    const glyph = s.ch[last];
    if (x2 < s.w && glyph && charWidth(glyph.codePointAt(0) ?? 32) === 2) repairs.push(capture(last + 1));
  }

  for (let row = y1; row < y2; row++) for (let col = x1; col < x2; col++) {
    const i = row * s.w + col;
    s.put(col, row, ' ', fg, typeof bg === 'function' ? bg(i) : bg, 0);
  }
  for (const cell of repairs) {
    s.ch[cell.i] = ' ';
    s.copyCh[cell.i] = ' ';
    s.fg[cell.i] = cell.fg;
    s.bg[cell.i] = cell.bg;
    s.at[cell.i] = cell.at;
  }
}

/** Horizontal rule. `weight` 0=light 1=heavy 2=block. */
export function rule(s, x, y, w, fg = T.rule, weight = 1, bg = DEFAULT) {
  const ch = weight === 0 ? LIGHT.h : weight === 1 ? HEAVY.h : BLOCK.full;
  for (let i = 0; i < w; i++) s.put(x + i, y, ch, fg, bg);
}

/** Rule that fades out toward its right end — used under headers. */
export function ruleFade(s, x, y, w, fg = T.rule, bg = T.bg, weight = 1) {
  const ch = weight === 0 ? LIGHT.h : HEAVY.h;
  for (let i = 0; i < w; i++) {
    const t = i / Math.max(1, w - 1);
    s.put(x + i, y, ch, mix(fg, bg, t * t * 0.92), bg);
  }
}

/** Vertical rule. */
export function vrule(s, x, y, h, fg = T.rule, weight = 1, bg = DEFAULT) {
  const ch = weight === 0 ? LIGHT.v : weight === 1 ? HEAVY.v : BLOCK.full;
  for (let j = 0; j < h; j++) s.put(x, y + j, ch, fg, bg);
}

/**
 * Sub-cell horizontal bar. `p` 0..1 of `w` columns; the partial cell uses
 * an eighth-block so motion reads smoothly instead of stepping.
 */
export function bar(s, x, y, w, p, fg = T.accent, trackFg = T.inset, bg = DEFAULT) {
  const total = clamp(p, 0, 1) * w;
  const full = Math.floor(total);
  const frac = Math.round((total - full) * 8);
  for (let i = 0; i < w; i++) {
    if (i < full) s.put(x + i, y, BLOCK.full, fg, bg);
    else if (i === full && frac > 0) s.put(x + i, y, LEFT_RAMP[frac], fg, bg);
    else s.put(x + i, y, BLOCK.full, trackFg, bg);
  }
}

/** Vertical sub-cell bar, grows upward from the baseline row. */
export function vbar(s, x, yBottom, h, p, fg = T.accent, bg = DEFAULT) {
  const total = clamp(p, 0, 1) * h;
  const full = Math.floor(total);
  const frac = Math.round((total - full) * 8);
  for (let j = 0; j < h; j++) {
    const y = yBottom - j;
    if (j < full) s.put(x, y, BLOCK.full, fg, bg);
    else if (j === full && frac > 0) s.put(x, y, UP_RAMP[frac], fg, bg);
  }
}

/** Text that dissolves in: `p` 0..1 reveals glyphs with a density pre-roll. */
export function textReveal(s, x, y, str, p, fg = T.fg, bg = DEFAULT, at = 0, maxW = Infinity) {
  const chars = [...String(str)];
  const n = chars.length;
  const head = clamp(p, 0, 1) * (n + 4);
  let cx = x;
  let used = 0;
  for (let i = 0; i < n; i++) {
    const cw = strWidth(chars[i]) || 1;
    if (used + cw > maxW) break;
    const d = head - i;
    if (d <= 0) break;
    if (d >= 3) {
      s.put(cx, y, chars[i], fg, bg, at);
    } else {
      // pre-roll: fade the glyph in from the paper color
      const k = clamp(d / 3, 0, 1);
      s.put(cx, y, chars[i], mix(bg === DEFAULT ? T.bg : bg, fg, k), bg, at);
    }
    cx += cw;
    used += cw;
  }
  return used;
}

/** Scanline shimmer: brightens a moving band across a row. */
export function shimmer(s, x, y, w, t, base = T.dim, hot = T.accent, speed = 9, width = 6) {
  const pos = ((t * speed) % (w + width * 2)) - width;
  for (let i = 0; i < w; i++) {
    const d = Math.abs(i - pos);
    if (d < width) s.tint(x + i, y, mix(base, hot, (1 - d / width) ** 2));
  }
}

/** Dot-matrix badge, e.g. status pills. */
export function badge(s, x, y, label, fg = T.bg, bg = T.accent, at = ATTR_BOLD) {
  const txt = ` ${label} `;
  s.text(x, y, txt, fg, bg, at);
  return strWidth(txt);
}

/** Key hint: highlighted key + dim label. Returns width consumed. */
export function hint(s, x, y, key, label) {
  let cx = x;
  cx += s.text(cx, y, key, T.bg, mix(T.fg, T.bg, 0.25), ATTR_BOLD);
  cx += s.text(cx, y, ` ${label}`, T.dim, DEFAULT, ATTR_DIM);
  return cx - x;
}

/** Sparkline from values 0..1. */
export function spark(s, x, y, vals, fg = T.accent2, bg = DEFAULT) {
  for (let i = 0; i < vals.length; i++) {
    const v = clamp(vals[i], 0, 1);
    s.put(x + i, y, UP_RAMP[Math.max(1, Math.round(v * 8))], fg, bg);
  }
}

/** Density-ramp fade of a filled rect, used for reveal wipes. */
export function dissolve(s, x, y, w, h, p, fg = T.fg, bg = DEFAULT) {
  const k = clamp(p, 0, 1);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const n = (((x + i) * 73856093) ^ ((y + j) * 19349663)) >>> 0;
      const th = (n % 1000) / 1000;
      if (th < k) continue;
      const idx = Math.round((1 - clamp((th - k) * 4, 0, 1)) * 4);
      if (idx > 0) s.put(x + i, y + j, DENSITY[idx], fg, bg);
    }
  }
}

/**
 * Windshield-wiper reveal. The destination frame is already drawn; this blanks
 * everything the blade hasn't reached yet and lays a hard edge plus a short
 * density trail at the head, so a jump reads as one swipe rather than a cut.
 *
 * `p` 0..1 is blade travel. `dir` 1 sweeps left→right, -1 right→left.
 */
export function wiper(s, x, y, w, h, p, dir = 1, bgFn = null, fg = T.accent) {
  const k = clamp(p, 0, 1);
  const travel = k * (w + 2);
  const edge = dir > 0 ? x + travel - 1 : x + w - travel;
  const TRAIL = 4;

  for (let i = 0; i < w; i++) {
    const cx = x + i;
    // signed distance ahead of the blade, in the direction it is travelling
    const ahead = dir > 0 ? cx - edge : edge - cx;

    if (ahead > 0) {
      // not yet wiped: hold the paper
      for (let j = 0; j < h; j++) {
        const bg = bgFn ? bgFn(cx, y + j) : T.bg;
        s.put(cx, y + j, ' ', bg, bg);
      }
      continue;
    }
    if (ahead > -1) {
      // the blade
      for (let j = 0; j < h; j++) s.put(cx, y + j, BLOCK.full, fg);
      continue;
    }
    if (ahead > -1 - TRAIL) {
      // trail: fade the fresh content up out of the accent
      const q = (-ahead - 1) / TRAIL;
      for (let j = 0; j < h; j++) s.tint(cx, y + j, mix(fg, T.fg, q));
    }
  }
}

/** Corner tick marks — small precise detail against the heavy frames. */
export function crops(s, x, y, w, h, fg = T.sand) {
  s.put(x - 1, y - 1, MARK.dot, fg);
  s.put(x + w, y - 1, MARK.dot, fg);
  s.put(x - 1, y + h, MARK.dot, fg);
  s.put(x + w, y + h, MARK.dot, fg);
}

export { shade, mix };
