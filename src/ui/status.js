// Bottom status bar: mode chip, key hints, transient toast, elapsed clock.

import { ATTR_BOLD, ATTR_DIM, DEFAULT, strWidth } from '../ansi.js';
import { BLOCK, MARK, SPIN_BAR } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { ease, clamp, norm } from '../anim.js';
import { hint, rule } from '../draw.js';
import { ellipsize } from '../wrap.js';

export const STATUS_H = 1;

export function drawStatus(s, st, y, t) {
  const { w } = s;
  s.fillRect(0, y, w, 1, ' ', T.dim, T.bg);

  // Explicit agent mode. Runtime activity has its own pulse beside this slab, so
  // Go/Plan never disappears while a request is running.
  const mode = st.plan?.mode === 'plan' ? 'PLAN' : 'GO';
  const chipBg = T.accent;
  let x = 0;
  const chipW = strWidth(` ${mode} `);
  x += s.text(x, y, ` ${mode} `, T.bg, chipBg, ATTR_BOLD);
  st.modeHit = { x1: 0, x2: chipW - 1, y };

  // busy pulse bar right after the chip
  if (st.busy) {
    const f = SPIN_BAR[Math.floor(t * 14) % SPIN_BAR.length];
    x += s.text(x + 1, y, f, T.accent, DEFAULT, ATTR_BOLD) + 1;
    const el = `${st.elapsed.toFixed(1)}s`;
    x += s.text(x + 1, y, el, T.dim, DEFAULT, ATTR_DIM) + 1;
  }

  // toast takes over the middle when active
  if (st.toast && st.toastLife > 0) {
    const p = clamp(st.toastLife / 0.35, 0, 1); // fade out over the last 350ms
    const rise = st.toastLife > st.toastMax - 0.2 ? ease.outBack(norm(st.toastMax - st.toastLife, 0, 0.2)) : 1;
    const txt = ellipsize(st.toast, Math.max(10, w - x - 24));
    const tx = x + 2;
    const col = st.toastKind === 'warn' ? T.warn : st.toastKind === 'ok' ? T.ok : T.accent2;
    s.put(tx, y, MARK.diamond, mix(T.bg, col, p * rise));
    s.text(tx + 2, y, txt, mix(T.bg, T.slate, p * rise), DEFAULT, rise > 0.9 ? 0 : ATTR_DIM);
  } else {
    // key hints
    const hints = st.busy
      ? [['esc', 'interrupt']]
      : [['↵', 'send'], ['⇧tab', 'mode'], ['alt+p', 'todos'], ['^p', 'palette'], ['^c', 'quit']];
    let hx = x + 2;
    for (const [k, l] of hints) {
      if (hx + strWidth(k) + strWidth(l) + 3 > w - 12) break;
      hx += hint(s, hx, y, ` ${k} `, l) + 2;
    }
  }

  // right: scroll position
  const pos = st.atBottom ? 'BOT' : `${Math.round(st.scrollPct * 100)}%`;
  s.textRight(w - 1, y, pos, mix(T.bg, T.sand, 1), DEFAULT, ATTR_DIM);
}
