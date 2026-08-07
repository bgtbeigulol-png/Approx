// Compact prompt queue floating immediately above the composer. It is deliberately
// not transcript content: the rows are pending envelopes, not user turns yet.

import { ATTR_BOLD, ATTR_DIM, strWidth } from '../ansi.js';
import { HEAVY, MARK, UP_RAMP } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { clamp, ease } from '../anim.js';
import { panel, shimmer } from '../draw.js';
import { ellipsize } from '../wrap.js';
import { MAX_QUEUED_TURNS } from '../queue.js';

export function queueHeight(st) {
  const live = st.messageQueue?.length ?? 0;
  const ghosts = st.queueGhosts?.length ?? 0;
  return live + ghosts ? live + ghosts + 2 : 0;
}

export function drawMessageQueue(s, st, x, y, w, t) {
  const items = st.messageQueue ?? [];
  const ghosts = st.queueGhosts ?? [];
  st.queueHits = [];
  if ((!items.length && !ghosts.length) || w < 24) return 0;
  const h = items.length + ghosts.length + 2;
  const p = ease.outQuint(clamp(st.queueAnim?.v ?? 1, 0, 1));
  const pulse = clamp(st.queuePulse?.v ?? 0, 0, 1);
  const bg = mix(T.cream, T.crust, 0.18);
  const border = mix(T.rule, T.accent2, 0.5 + pulse * 0.25);

  panel(s, x, y, w, h, {
    bg, border, style: HEAVY, shadow: true, shadowOff: 1,
    shadowColor: mix(T.bg, T.accent2, 0.13), label: 'QUEUE', labelColor: T.accent2,
  });
  const count = ` ${items.length}/${MAX_QUEUED_TURNS} `;
  s.text(x + w - strWidth(count) - 2, y, count, T.dim, bg, ATTR_DIM);

  // Merge live rows and ghosts into one ordered column. `base` is each row's
  // fixed enqueue slot; ghosts keep theirs while they fade so the list reflows
  // by glide rather than by index rewrite.
  const rows = [
    ...items.map((item, i) => ({ item, ghost: false, order: item.base ?? i })),
    ...ghosts.map((g) => ({ item: g, ghost: true, order: g.base })),
  ].sort((a, b) => a.order - b.order);

  let liveSeen = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const item = row.item;
    const leaving = row.ghost;
    if (!leaving) {
      item.liveIndex = liveSeen;
      liveSeen++;
    }
    const ip = clamp((item.anim?.v ?? 1) * p, 0, 1);
    if (leaving && ip <= 0.02) continue;

    // Reflow by eased glide: right after a ghost above is pruned, a live row
    // holds its old (one-slot-low) position via `y` and eases up to its settled
    // slot; ghosts render in their own slot while collapsing.
    const yBase = y + 1 + r;
    const yOff = leaving ? 0 : Math.round(clamp(item.y?.v ?? 0, 0, 2));
    const ryF = yBase + yOff;
    if (ryF < y + 1 || ryF > y + h - 2) continue;

    const isFirst = !leaving && item.liveIndex === 0;
    const rowBg = isFirst ? mix(bg, T.inset, 0.55) : bg;
    s.fillRect(x + 1, ryF, w - 2, 1, ' ', T.fg, rowBg);
    const rail = isFirst ? T.accent : mix(T.accent2, T.rule, r / Math.max(1, rows.length));

    if (leaving) {
      // Exit: the envelope collapses — rail drains, content fades out and
      // slides toward the × as the presence spring goes 1 → 0.
      const e = ease.outQuint(ip);
      const railH = Math.max(1, Math.round(e * 8));
      s.put(x + 1, ryF, UP_RAMP[railH], mix(bg, T.accent2, e), rowBg);
      const dx = Math.round((1 - e) * 6);
      const textX = x + 12 + dx;
      s.text(textX, ryF, ellipsize(item.text, Math.max(1, x + w - 3 - textX - 2)),
        mix(rowBg, T.slate, e), rowBg, ATTR_DIM);
      const ordinal = String(item.base + 1).padStart(2, '0');
      s.text(x + 3 + dx, ryF, ordinal, mix(rowBg, T.dim, e), rowBg, ATTR_DIM);
      s.text(x + 6 + dx, ryF, 'OUT', mix(rowBg, T.dim, e), rowBg, ATTR_DIM);
      continue;
    }

    // Enter: slide in from the right, fade up, and the rail bar grows into
    // place — no hard pop.
    const ipE = ease.outQuint(ip);
    const dx = Math.round((1 - ipE) * 6);
    const railH = Math.max(1, Math.round(ipE * 8));
    s.put(x + 1, ryF, UP_RAMP[railH], mix(bg, rail, ipE), rowBg);
    const ordinal = String(item.liveIndex + 1).padStart(2, '0');
    s.text(x + 3 + dx, ryF, ordinal, mix(rowBg, isFirst ? T.accent : T.dim, ipE), rowBg, ATTR_BOLD);
    const state = isFirst ? 'NEXT' : 'WAIT';
    s.text(x + 6 + dx, ryF, state, mix(rowBg, isFirst ? T.accent2 : T.dim, ipE), rowBg, ATTR_BOLD);
    const deleteText = `${MARK.times ?? '×'}`;
    const deleteX = x + w - 3;
    s.text(deleteX, ryF, deleteText, mix(rowBg, T.accent, 0.8 * ipE), rowBg, ATTR_BOLD);
    st.queueHits.push({ index: item.liveIndex, x1: deleteX - 1, x2: deleteX + Math.max(1, strWidth(deleteText)), y: ryF });
    const textX = x + 12 + dx;
    s.text(textX, ryF, ellipsize(item.text, Math.max(1, deleteX - textX - 2)),
      mix(rowBg, T.slate, ipE), rowBg, isFirst ? 0 : ATTR_DIM);
    if (isFirst) shimmer(s, x + 2, ryF, Math.max(1, w - 5), t, border, T.accent, 8, 5);
  }

  const foot = ' alt+⌫ drop last ';
  if (strWidth(foot) + 4 < w) s.text(x + 2, y + h - 1, foot, T.dim, bg, ATTR_DIM);
  return h;
}
