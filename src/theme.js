// Condensed-milk palette. Warm off-white paper, near-black ink, one hot accent.
import { rgb, mix, shade } from './ansi.js';

export const C = {
  // paper stack — lightest to dustiest
  milk: rgb('#F7EEDD'), //  page
  cream: rgb('#EFE2C9'), // raised panel
  crust: rgb('#E2D0AE'), // pressed / inset
  sand: rgb('#CBB794'), // hairline rules

  // structure
  concrete: rgb('#8E8272'), // secondary text
  slate: rgb('#514A41'), // strong secondary
  ink: rgb('#1C1815'), // primary text
  pitch: rgb('#0E0C0A'), // shadow / inverted panel

  // signal
  vermilion: rgb('#D9481F'),
  ember: rgb('#E8863B'),
  amber: rgb('#C9910F'), // rail: your turns
  moss: rgb('#4E7A5E'),
  teal: rgb('#2F6B78'),
  plum: rgb('#7A4A63'),
};

export const T = {
  // Keep the raw palette names available to drawing code as well as the
  // semantic aliases below. Several overlays intentionally use the paper-stack
  // steps directly; leaving those keys out turns `undefined` into RGB black in
  // bitwise colour mixing, which made whole list rows render as black slabs.
  ...C,
  bg: C.milk,
  fg: C.ink,
  dim: C.concrete,
  rule: C.sand,
  panel: C.cream,
  inset: C.crust,
  shadow: mix(C.milk, C.pitch, 0.72),
  accent: C.vermilion,
  accent2: C.teal,
  ok: C.moss,
  warn: C.ember,
};

// `bar` is the in-transcript gutter wipe; `rail` is the navigation tick on the
// left edge, where roles have to separate at a glance from two columns of block.
export const ROLE = {
  user: { tag: 'YOU', color: C.slate, bar: C.slate, rail: C.amber },
  approx: { tag: 'APPROX', color: C.ink, bar: C.vermilion, rail: C.vermilion },
  system: { tag: 'SYS', color: C.concrete, bar: C.sand, rail: C.sand },
  tool: { tag: 'TOOL', color: C.teal, bar: C.teal, rail: C.teal },
  toolgroup: { tag: 'TOOL CALLS', color: C.teal, bar: C.teal, rail: C.teal },
  work: { tag: 'WORK', color: C.teal, bar: C.teal, rail: C.teal },
  workgroup: { tag: 'WORK', color: C.teal, bar: C.teal, rail: C.teal },
  guest: { tag: 'GUEST', color: C.plum, bar: C.plum, rail: C.plum },
};

/** Paper grain placement: deterministic, sparse, and free of column banding. */
export function grain(x, y) {
  let n = Math.imul(x + 0x7f4a7c15, 0x9e3779b1) ^ Math.imul(y + 0x165667b1, 0x85ebca77);
  n ^= n >>> 16;
  n = Math.imul(n, 0x7feb352d);
  n ^= n >>> 15;
  return (n >>> 0) % 31 === 0 ? 1 : 0;
}

/**
 * Page background. Keep it uniform: per-cell background shades can repaint one
 * half of a terminal-wide CJK glyph. Texture is drawn as foreground specks below.
 */
export function paper() {
  return T.bg;
}

/** Sparse foreground texture over a uniform background, safe under wide glyphs. */
export function drawPaperGrain(s, x = 0, y = 0, w = s.w, h = s.h) {
  const fg = mix(T.bg, C.sand, 0.11);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      if (grain(x + col, y + row)) s.put(x + col, y + row, '·', fg, T.bg);
    }
  }
}

export { mix, shade };
