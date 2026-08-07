// Top chrome: wordmark slab, breadcrumb, live meters. Two rows + a rule.

import { ATTR_BOLD, ATTR_DIM, DEFAULT, strWidth } from '../ansi.js';
import { MARK, SPIN_BRAILLE, UP_RAMP } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { ease, clamp, norm } from '../anim.js';
import { ruleFade, spark, shimmer, bar } from '../draw.js';
// clamp keeps the meter widths inside whatever the terminal actually gives us
import { ellipsize } from '../wrap.js';

export const HEADER_H = 3;

export function drawHeader(s, st, t) {
  const { w } = s;
  const intro = ease.outCubic(norm(st.age, 0, 420));

  // --- row 0: inverted slab wordmark + context path ---
  const slabW = Math.round(10 * intro);
  s.fillRect(0, 0, w, 1, ' ', T.fg, T.bg);
  if (slabW > 1) {
    s.fillRect(0, 0, slabW, 1, ' ', T.bg, T.fg);
    s.text(1, 0, ellipsize('APPROX', slabW - 2), T.bg, T.fg, ATTR_BOLD);
  }

  // right cluster claims its space first, so the breadcrumb can never run into it
  const chip = st.model;
  const chipW = strWidth(chip) + 2;
  const chipX = w - chipW - 1;
  const rightEdge = chipX - (st.busy ? 3 : 1); // leave room for the spinner

  let x = 12;
  if (intro > 0.55 && rightEdge > 16) {
    const p = norm(intro, 0.55, 1);
    const budget = rightEdge - 12;
    const bw = st.branch ? Math.min(strWidth(st.branch) + 4, Math.floor(budget / 2)) : 0;
    x += s.text(x, 0, MARK.caret, mix(T.bg, T.sand, p)) + 1;
    x += s.text(x, 0, ellipsize(st.cwd, Math.max(3, budget - bw)), mix(T.bg, T.dim, p), DEFAULT, ATTR_DIM);
    if (st.branch && bw > 4) {
      x += s.text(x, 0, `  ${MARK.diamond} `, mix(T.bg, T.sand, p));
      s.text(x, 0, ellipsize(st.branch, bw - 4), mix(T.bg, T.accent2, p), DEFAULT, ATTR_BOLD, rightEdge - x);
    }
  }

  if (intro > 0.7 && chipX > 12) {
    s.text(chipX, 0, ` ${chip} `, T.bg, mix(T.bg, T.accent, norm(intro, 0.7, 1)), ATTR_BOLD);
    if (st.busy) {
      const f = SPIN_BRAILLE[Math.floor(t * 12) % SPIN_BRAILLE.length];
      s.put(chipX - 2, 0, f, T.accent);
    }
  }

  // --- row 1: fading rule with a shimmer when busy ---
  const rw = Math.round(w * ease.outQuint(norm(st.age, 60, 700)));
  ruleFade(s, 0, 1, rw, T.rule, T.bg, 1);
  if (st.busy) shimmer(s, 0, 1, rw, t, T.rule, T.accent, 14, 9);

  // --- row 2: meters strip. Each cluster only draws if it fits. ---
  if (intro > 0.8) {
    const p = norm(intro, 0.8, 1);
    const turns = `${st.turns} ${st.turns === 1 ? 'turn' : 'turns'}`;
    const turnsW = strWidth(turns);
    const right = w - turnsW - 3;
    let mx = 1;

    const barW = clamp(Math.floor((right - 12) * 0.45), 4, 14);
    if (right > 14) {
      mx += s.text(mx, 2, 'CTX', mix(T.bg, T.dim, p), DEFAULT, ATTR_DIM) + 1;
      bar(s, mx, 2, barW, st.ctxUse.v * p, mix(T.bg, ctxColor(st.ctxUse.v), p), mix(T.bg, T.inset, p));
      mx += barW + 1;
      mx += s.text(mx, 2, `${Math.round(st.ctxUse.v * 100)}%`, mix(T.bg, T.dim, p), DEFAULT, ATTR_DIM) + 2;
    }

    // Real rolling tokens/second plus a history normalized to its own recent peak.
    const tpsText = `TPS ${formatTps(st.tpsNow)}`;
    const room = right - mx - strWidth(tpsText) - 1;
    if (room >= 5) {
      mx += s.text(mx, 2, tpsText, mix(T.bg, T.dim, p), DEFAULT, ATTR_DIM) + 1;
      const vals = st.tps.slice(Math.max(0, st.tps.length - room));
      const peak = Math.max(1, ...vals);
      spark(s, mx, 2, vals.map((value) => value / peak), mix(T.bg, T.accent2, p));
    }

    s.textRight(w - 2, 2, turns, mix(T.bg, T.dim, p), DEFAULT, ATTR_DIM);
  }
}

function formatTps(value) {
  const n = Number(value) || 0;
  return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

function ctxColor(v) {
  if (v > 0.85) return T.accent;
  if (v > 0.6) return T.warn;
  return T.ok;
}
