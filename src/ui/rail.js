// Left navigation rail. One short dash per message, placed at the message's
// proportional position in the document, so the rail doubles as a minimap.
// The dash under the pointer grows to full width and its neighbours give way.

import { ATTR_BOLD, ATTR_DIM, DEFAULT } from '../ansi.js';
import { BLOCK, LEFT_RAMP, MARK } from '../glyphs.js';
import { T, ROLE, mix } from '../theme.js';
import { clamp } from '../anim.js';
import { msgHeight } from './transcript.js';
import { logicalTimeline } from './jumplist.js';

export const RAIL_W = 3;

const LABEL_CHARS = 10; // 前 10 个字
const BASE = 1.5; // resting dash length, in columns
const PEAK = RAIL_W; // hovered dash length
export const SIGMA = 2.0; // how many rows away the bulge still reaches
const SHRINK = 0.55; // resting length multiplier while something else is hovered
const EDGE_SLOP = 1; // rows of grace past the first / last tick

/**
 * Place one tick per message, or per logical timeline item when `logical` is true.
 * Rows are proportional to document position, so the rail doubles as a minimap.
 *
 * Two messages can want the same row once the document is taller than the rail.
 * A collision searches down first, then up, so a long transcript compresses from
 * both ends instead of silently dropping its newest messages off the bottom —
 * which is the one thing a jump-to-message control must never lose.
 */
export function railTicks(msgs, bodyW, h, { logical = false } = {}) {
  const ticks = [];
  if (h <= 0 || !msgs.length) return ticks;
  const heights = msgs.map((m) => msgHeight(m, bodyW));
  const prefix = [0];
  for (const height of heights) prefix.push(prefix.at(-1) + height);
  const items = logical
    ? logicalTimeline(msgs)
    : msgs.map((msg, index) => ({ msg, index, rawEndIndex: index + 1, kind: 'message' }));
  if (!items.length) return ticks;
  const origin = logical && items.length ? prefix[clamp(Number(items[0].index) || 0, 0, msgs.length)] : 0;
  const endIndex = logical && items.length
    ? clamp(Number(items.at(-1).rawEndIndex) || msgs.length, 0, msgs.length)
    : msgs.length;
  const doc = Math.max(1, prefix[endIndex] - origin);
  const span = Math.max(1, doc - 1);
  const taken = new Uint8Array(h);

  for (const item of items) {
    const rawIndex = clamp(Number(item.index) || 0, 0, msgs.length - 1);
    const rawEnd = clamp(Number(item.rawEndIndex) || rawIndex + 1, rawIndex + 1, msgs.length);
    const docY = Math.max(0, prefix[rawIndex] - origin);
    const mh = Math.max(1, prefix[rawEnd] - prefix[rawIndex]);
    const want = clamp(Math.round((docY / span) * (h - 1)), 0, h - 1);
    let row = -1;
    for (let d = 0; d < h; d++) {
      const down = want + d;
      const up = want - d;
      if (down < h && !taken[down]) {
        row = down;
        break;
      }
      if (up >= 0 && !taken[up]) {
        row = up;
        break;
      }
    }
    if (row >= 0) {
      taken[row] = 1;
      ticks.push({
        msg: item.msg,
        index: rawIndex,
        row,
        docY,
        rawDocY: prefix[rawIndex],
        mh,
        kind: item.kind,
        logical: item,
      });
    }
  }
  ticks.sort((a, b) => a.row - b.row);
  return ticks;
}

/**
 * The tick owning a rail row. Rows are partitioned at the midpoints between
 * neighbouring ticks, so every row between the first and the last belongs to
 * exactly one message and the hit region never changes as dashes grow or shrink.
 *
 * The alternative — nearest tick within a row or two of slop — leaves dead rows
 * in the gaps of a sparse rail, and sliding across one drops the hover, starts
 * the fade, then re-arms on the next tick mid-decay. Handing off cleanly is what
 * keeps a fast slide from stuttering.
 */
export function tickAtRow(ticks, row) {
  const n = ticks.length;
  if (!n || row < ticks[0].row - EDGE_SLOP || row > ticks[n - 1].row + EDGE_SLOP) return null;
  let best = ticks[0];
  for (let i = 1; i < n; i++) {
    if (row < (ticks[i - 1].row + ticks[i].row) / 2) break;
    best = ticks[i];
  }
  return best;
}

/** First N characters of a message, whitespace collapsed. */
export function tickLabel(msg) {
  const flat = String(msg.text ?? '')
    .replace(/^```.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const src = flat || (msg.name ? `${msg.name}()` : msg.role);
  const chars = [...src];
  const head = chars.slice(0, LABEL_CHARS).join('');
  return chars.length > LABEL_CHARS ? `${head}${MARK.ellipsis}` : head;
}

/**
 * Draw the rail. `bulge` is the animated row the bulge is centred on and
 * `amt` 0..1 how much of it has arrived; both come from springs in app state.
 * `view` marks which document rows are currently on screen so off-screen
 * messages read as quieter.
 */
export function drawRail(s, ticks, x, y, h, { bulge, amt, hoverIndex, view }) {
  // spine: a hairline the dashes hang off, so an empty rail still reads as UI
  for (let i = 0; i < h; i++) {
    s.put(x, y + i, BLOCK.l1, mix(T.bg, T.rule, 0.5));
  }

  for (const tk of ticks) {
    const role = ROLE[tk.msg.role] ?? ROLE.approx;
    const hot = tk.index === hoverIndex;
    // Every dash — including the one under the pointer — takes its length from one
    // gaussian centred on the bulge spring. The bulge is critically damped, so it
    // homes on the hovered row without ringing; giving the hovered dash a special
    // "always full" weight instead just trades a smooth chase for a step: it pops
    // when a switch flips the flag, and any spring that softens that pop has to
    // climb from low and so flickers on a fast slide. One gaussian, no special case,
    // has neither failure — the dash dims a hair while the bulge catches the pointer,
    // then fills. `hot` now only drives the emphasis (bold + tint), not the length.
    const d = tk.row - bulge;
    const wgt = amt > 0.001 ? Math.exp(-(d * d) / (2 * SIGMA * SIGMA)) : 0;
    const rest = BASE * (1 - amt * (1 - SHRINK));
    const len = clamp(rest + amt * (PEAK - BASE * SHRINK) * wgt, 0.4, PEAK);

    const onScreen = tk.docY + tk.mh > view.top && tk.docY < view.bottom;
    let col = role.rail;
    if (!onScreen) col = mix(T.bg, col, 0.5);
    if (hot) col = mix(col, T.fg, 0.15);
    else if (amt > 0.001) col = mix(mix(T.bg, col, 0.75), col, wgt);

    const full = Math.floor(len);
    const frac = Math.round((len - full) * 8);
    const ry = y + tk.row;
    for (let i = 0; i < full; i++) s.put(x + i, ry, BLOCK.full, col, DEFAULT, hot ? ATTR_BOLD : 0);
    if (frac > 0 && full < RAIL_W) s.put(x + full, ry, LEFT_RAMP[frac], col);
  }
}

/**
 * The hover label, drawn after the transcript so it sits over the text.
 * Returns nothing; purely an overlay.
 */
export function drawRailLabel(s, tick, x, y, amt, maxW) {
  if (!tick || amt <= 0.02) return;
  const role = ROLE[tick.msg.role] ?? ROLE.approx;
  const txt = ` ${tickLabel(tick.msg)} `;
  const bg = mix(T.bg, role.rail, 0.22 * amt);
  const fg = mix(T.bg, T.fg, clamp(amt * 1.4, 0, 1));
  const room = Math.max(0, maxW);
  s.put(x, y, BLOCK.full, mix(T.bg, role.rail, amt), DEFAULT, ATTR_BOLD);
  s.text(x + 1, y, txt, fg, bg, ATTR_BOLD, room - 1);
}
