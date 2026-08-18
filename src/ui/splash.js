// Boot splash: logotype strikes in, rules extend, subtitle dissolves, whole thing lifts away.

import { ATTR_BOLD, ATTR_DIM, DEFAULT } from '../ansi.js';
import { bigWord, BLOCK, MARK } from '../glyphs.js';
import { T, mix, drawPaperGrain } from '../theme.js';
import { ease, clamp, norm, smooth } from '../anim.js';
import { rule, textReveal, crops } from '../draw.js';
import { padTo } from '../wrap.js';
import { APPROX_VERSION } from '../version.js';

const WORD = bigWord('APPROX', 1);
const LOGO_W = WORD[0].length;
export const SPLASH_MS = 2050;

/**
 * Draw the splash for elapsed time `ms`. Returns 0..1 progress; 1 means done.
 * Phases: bars slam down -> letters wipe in -> rules extend -> tagline -> exit lift.
 */
export function drawSplash(s, ms) {
  const { w, h } = s;
  s.clear(T.bg, T.fg);
  drawPaperGrain(s);

  const cx = Math.floor((w - LOGO_W) / 2);
  const cy = Math.floor(h / 2) - 4;

  // 0. exit — everything slides up and dissolves
  const exitP = norm(ms, SPLASH_MS - 420, SPLASH_MS);
  const lift = Math.round(ease.inOutCubic(exitP) * 8);
  const fade = 1 - ease.inOutQuad(exitP);

  // 1. letterform strike: each row wipes L->R, rows staggered
  for (let r = 0; r < 5; r++) {
    const rowP = norm(ms, 120 + r * 62, 520 + r * 62);
    const eased = ease.outExpo(rowP);
    const reveal = Math.round(eased * LOGO_W);
    const y = cy + r - lift;
    const row = WORD[r];
    for (let i = 0; i < reveal; i++) {
      const ch = row[i];
      if (ch === ' ') continue;
      // leading edge glows in the accent, body settles to ink
      const edge = clamp((reveal - i) / 5, 0, 1);
      const col = mix(T.accent, T.fg, ease.outQuad(1 - edge));
      s.put(cx + i, y, BLOCK.full, mix(T.bg, col, fade), DEFAULT, ATTR_BOLD);
    }
    // motion streak ahead of the wipe
    if (rowP > 0 && rowP < 1) {
      for (let k = 0; k < 3; k++) {
        const x = cx + reveal + k;
        if (row[reveal + k] && row[reveal + k] !== ' ') {
          s.put(x, y, ['▓', '▒', '░'][k], mix(T.bg, T.accent, (0.7 - k * 0.22) * fade));
        }
      }
    }
  }

  // 2. flanking rules extend outward from the logotype
  const ruleP = ease.outQuint(norm(ms, 430, 1080));
  const halfMax = Math.floor((w - LOGO_W) / 2) - 3;
  const ext = Math.round(ruleP * halfMax);
  const ry = cy + 2 - lift;
  for (let i = 0; i < ext; i++) {
    const t = i / Math.max(1, ext);
    const col = mix(T.rule, T.bg, t * 0.75);
    s.put(cx - 2 - i, ry, '━', mix(T.bg, col, fade));
    s.put(cx + LOGO_W + 1 + i, ry, '━', mix(T.bg, col, fade));
  }

  // 3. underline slab + tagline
  const slabP = ease.outQuint(norm(ms, 620, 1180));
  const slabW = Math.round(slabP * LOGO_W);
  if (slabW > 0) {
    rule(s, cx, cy + 5 - lift, slabW, mix(T.bg, T.accent, fade), 2);
  }

  const tagP = norm(ms, 900, 1560);
  const tag = 'APPROXIMATE  ·  ITERATE  ·  CONVERGE';
  const tx = Math.floor((w - tag.length) / 2);
  textReveal(s, tx, cy + 7 - lift, tag, tagP, mix(T.bg, T.dim, fade * 0.95), DEFAULT, ATTR_DIM);

  // 4. version chip, snaps in last
  const chipP = ease.outBack(norm(ms, 1240, 1620));
  if (chipP > 0.02) {
    const version = `v${APPROX_VERSION}`;
    const label = padTo(version, Math.max(1, Math.round(version.length * clamp(chipP, 0, 1))), 'left').trimEnd();
    if (label) {
      const bx = Math.floor((w - 8) / 2);
      const by = cy + 9 - lift;
      s.text(bx, by, ` ${label} `, mix(T.bg, T.bg, 1), mix(T.bg, T.fg, fade * 0.9), ATTR_BOLD);
    }
  }

  // 5. corner crop marks frame the whole composition
  const cropP = norm(ms, 1400, 1800);
  if (cropP > 0) {
    const pad = 2;
    const cf = mix(T.bg, T.sand, fade * cropP);
    for (const [x, y] of [[pad, pad], [w - pad - 1, pad], [pad, h - pad - 1], [w - pad - 1, h - pad - 1]]) {
      s.put(x, y, MARK.dot, cf);
    }
  }

  // 6. loading tick at the bottom
  const barP = norm(ms, 240, SPLASH_MS - 500);
  const bw = Math.min(28, w - 8);
  const bx = Math.floor((w - bw) / 2);
  const by = h - 4;
  for (let i = 0; i < bw; i++) {
    const on = i / bw < barP;
    const c = on ? mix(T.bg, T.accent, fade) : mix(T.bg, T.inset, fade);
    s.put(bx + i, by, on ? '▬' : '─', c);
  }

  return exitP >= 1 ? 1 : clamp(ms / SPLASH_MS, 0, 0.999);
}
