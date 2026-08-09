// /git — the Git workbench.
//
// Two file lanes (worktree / staged) straddle an index gate; a numbered diff
// pane fills the lower half; a commit rail runs under the masthead. The layout
// is laid against a running cursor and every block is only drawn when it fits,
// so a narrow terminal degrades to plain rows rather than clipping mid-glyph.

import { ATTR_BOLD, ATTR_DIM, DEFAULT, strWidth } from '../ansi.js';
import { clamp, ease } from '../anim.js';
import { BLOCK, DASH, HEAVY, LIGHT, MARK, SPIN_BRAILLE } from '../glyphs.js';
import { drawPaperGrain, T, mix } from '../theme.js';
import { ellipsize } from '../wrap.js';

export function drawGit(s, st, t) {
  const state = st.git;
  const p = clamp(state?.anim?.v ?? 0, 0, 1);
  if (!state || p <= 0.001) return;
  state.hits = [];
  state.laneBox = [null, null];

  const reveal = ease.outCubic(p);
  const startX = Math.round((1 - reveal) * Math.min(16, s.w));
  s.fillRect(0, 0, s.w, s.h, ' ', T.fg, T.bg);
  drawPaperGrain(s, 0, 1, s.w, Math.max(0, s.h - 2));
  drawTopBar(s, state, t, startX, p);

  const laneY = s.h < 14 ? 2 : 3;
  const listY = laneY + 1;
  const listH = clamp(Math.floor(s.h * 0.28), 2, 8);
  const gateW = s.w < 52 ? 3 : 7;
  const usable = Math.max(8, s.w - 2 - gateW);
  const leftW = Math.floor(usable / 2);
  const rightW = usable - leftW;
  const leftX = 1 + startX;
  const gateX = leftX + leftW;
  const rightX = gateX + gateW;

  drawLane(s, state, 0, leftX, laneY, leftW, listH, p);
  drawGate(s, state, gateX, laneY, gateW, listH + 1, t, p);
  drawLane(s, state, 1, rightX, laneY, rightW, listH, p);

  const diffY = Math.min(s.h - 3, listY + listH + 1);
  drawDiff(s, state, 1 + startX, diffY, Math.max(8, s.w - 2 - startX), s.h - diffY - 1, t, p);
  drawFooter(s, state, s.h - 1, p);
}

function drawTopBar(s, state, t, shift, p) {
  s.fillRect(0, 0, s.w, 1, ' ', T.bg, T.pitch);
  const compact = s.w < 44;
  const hoverKind = state.hover?.kind;
  const title = compact ? ' GIT ' : ' GIT / WORKBENCH ';
  const close = compact ? ' × ' : ' ESC × ';
  const refresh = state.loading
    ? ` ${SPIN_BRAILLE[Math.floor(t * 12) % SPIN_BRAILLE.length]} `
    : compact ? ' ↻ ' : ' R ↻ ';
  const closeX = Math.max(0, s.w - strWidth(close));
  const refreshX = Math.max(0, closeX - strWidth(refresh));

  s.text(shift, 0, title, T.pitch, T.ok, ATTR_BOLD, s.w - shift);
  let x = shift + strWidth(title) + 1;

  // Branch chip, then divergence arrows and a short dirty summary so the state
  // of the tree reads from the masthead alone.
  const branch = `${MARK.diamond} ${state.branch.name}`;
  const branchRoom = Math.max(0, refreshX - x - 1);
  if (branchRoom > 0) {
    x += s.text(x, 0, ellipsize(branch, branchRoom),
      state.branch.detached ? T.warn : T.cream, T.pitch, ATTR_BOLD, branchRoom) + 1;
  }
  if (!compact && state.branch.upstream && x < refreshX - 4) {
    x += s.text(x, 0, `${MARK.arrow} ${state.branch.upstream} `, mix(T.pitch, T.sand, 0.85), T.pitch, ATTR_DIM);
  }
  if (!compact && state.branch.ahead && x < refreshX - 2) {
    x += s.text(x, 0, `↑${state.branch.ahead} `, T.ok, T.pitch, ATTR_BOLD);
  }
  if (!compact && state.branch.behind && x < refreshX - 2) {
    x += s.text(x, 0, `↓${state.branch.behind} `, T.warn, T.pitch, ATTR_BOLD);
  }
  if (!compact && x < refreshX - 3) {
    const dirty = (state.lanes[0]?.length ?? 0) + (state.lanes[1]?.length ?? 0);
    if (!dirty) {
      s.text(x, 0, 'clean', mix(T.pitch, T.ok, 0.8), T.pitch, ATTR_DIM, refreshX - x - 1);
    } else {
      // Change overview: the total +/− line tally across both lanes, then the
      // file count. Each segment clips to the room left before the refresh key.
      const totals = state.totals ?? { added: 0, removed: 0 };
      let tx = x;
      const room = () => Math.max(0, refreshX - tx - 1);
      tx += s.text(tx, 0, '+', mix(T.pitch, T.ok, 0.5), T.pitch, ATTR_DIM, room());
      tx += s.text(tx, 0, String(totals.added), T.ok, T.pitch, ATTR_BOLD, room());
      tx += s.text(tx, 0, ' −', mix(T.pitch, T.accent, 0.5), T.pitch, ATTR_DIM, room());
      tx += s.text(tx, 0, String(totals.removed), T.accent, T.pitch, ATTR_BOLD, room());
      if (tx + 1 < refreshX - 1) {
        s.text(tx + 1, 0, `${dirty} file${dirty === 1 ? '' : 's'}`,
          mix(T.pitch, T.ember, 0.8), T.pitch, ATTR_DIM, refreshX - tx - 2);
      }
    }
  }

  s.text(refreshX, 0, refresh, T.pitch, hoverKind === 'refresh' ? T.cream : T.ember, ATTR_BOLD);
  s.text(closeX, 0, close, T.bg, hoverKind === 'close' ? T.ember : T.accent, ATTR_BOLD);
  state.hits.push({ kind: 'refresh', x1: refreshX, x2: closeX - 1, y: 0 });
  state.hits.push({ kind: 'close', x1: closeX, x2: s.w - 1, y: 0 });

  if (s.h < 14) return;
  drawCommitRail(s, state, shift, 1, p);
}

/** Recent commits as a graph node + subject, drawn along row 1. */
function drawCommitRail(s, state, shift, y, p) {
  let railX = shift + 1;
  if (!state.commits.length) {
    s.text(railX, y, state.branch.initial ? 'no commits yet' : '—', mix(T.bg, T.dim, p), DEFAULT, ATTR_DIM);
    return;
  }
  for (let i = 0; i < state.commits.length && railX < s.w - 5; i++) {
    const commit = state.commits[i];
    const node = i === 0 ? '◉' : '●';
    s.put(railX, y, node, i === 0 ? T.accent : mix(T.bg, T.slate, 0.76), DEFAULT, ATTR_BOLD);
    railX += 2;
    railX += s.text(railX, y, commit.hash, i === 0 ? T.ember : mix(T.bg, T.dim, 0.9), DEFAULT, ATTR_BOLD) + 1;
    const room = Math.min(28, s.w - railX - 8);
    if (room > 2) {
      railX += s.text(railX, y, ellipsize(commit.subject, room),
        i === 0 ? T.fg : T.dim, DEFAULT, i === 0 ? ATTR_BOLD : ATTR_DIM, room) + 1;
    }
    if (commit.age && railX < s.w - 6) {
      railX += s.text(railX, y, commit.age, mix(T.bg, T.slate, 0.7), DEFAULT, ATTR_DIM) + 1;
    }
    if (i < state.commits.length - 1 && railX < s.w - 2) {
      s.put(railX++, y, HEAVY.h, mix(T.bg, T.rule, 0.8));
    }
  }
}

function drawLane(s, state, lane, x, y, w, listH, p) {
  if (w < 1 || x >= s.w) return;
  const active = state.lane === lane;
  const tint = lane === 0 ? T.accent2 : T.ok;
  const title = lane === 0 ? 'WORKTREE' : 'STAGED';
  const files = state.lanes[lane] ?? [];
  const count = String(files.length).padStart(2, '0');
  const headBg = active ? mix(T.bg, tint, 0.2) : mix(T.bg, T.inset, 0.5);

  // Header bar: a solid block edge when active, plus the count badge.
  s.fillRect(x, y, w, 1, ' ', T.fg, headBg);
  s.put(x, y, active ? BLOCK.full : BLOCK.l2, active ? tint : T.rule, headBg);
  s.text(x + 2, y, ellipsize(title, Math.max(1, w - 7)),
    active ? T.fg : T.slate, headBg, ATTR_BOLD);
  if (w >= 5) {
    s.textRight(x + w - 1, y, count, active ? mix(headBg, tint, 0.95) : T.dim, headBg, ATTR_BOLD);
  }

  const selected = state.selected[lane] ?? 0;
  state.laneScroll ??= [0, 0];
  let scroll = clamp(state.laneScroll[lane] ?? 0, 0, Math.max(0, files.length - listH));
  if (selected < scroll) scroll = selected;
  if (selected >= scroll + listH) scroll = selected - listH + 1;
  state.laneScroll[lane] = scroll;

  const rowsTop = y + 1;
  const rowsBottom = Math.min(y + listH, s.h - 2);
  // Record the rectangle so a wheel event over this list moves the list.
  state.laneBox[lane] = { x1: x, x2: x + w - 1, y1: rowsTop, y2: rowsBottom };

  const visible = files.slice(scroll, scroll + listH);
  for (let i = 0; i < listH; i++) {
    const rowY = y + 1 + i;
    if (rowY >= s.h - 1) break;
    const file = visible[i];
    const rowP = clamp(p * (listH + 2) - i * 0.34, 0, 1);
    if (!file || rowP <= 0.02) {
      if (i === 0 && !files.length) s.text(x + 2, rowY, 'clean', mix(T.bg, T.dim, p), DEFAULT, ATTR_DIM);
      continue;
    }
    const fileIndex = scroll + i;
    const isSelected = active && selected === fileIndex;
    const isHover = state.hover?.kind === 'file' && state.hover.lane === lane && state.hover.index === fileIndex;
    const rowBg = isSelected ? mix(T.bg, tint, 0.22)
      : isHover ? mix(T.bg, tint, 0.1) : T.bg;
    s.fillRect(x, rowY, w, 1, ' ', T.fg, rowBg);
    if (isSelected) s.put(x, rowY, BLOCK.l2, tint, rowBg);
    const color = markColor(file.mark);
    const mark = file.mark === '?' ? '+' : file.mark;
    s.text(x + 1, rowY, mark.padEnd(2), mix(T.bg, color, rowP), rowBg, ATTR_BOLD, Math.min(2, w - 1));
    if (w > 4) {
      const renamed = file.originalPath ? `${file.originalPath} ${MARK.arrow} ${file.path}` : file.path;
      s.text(x + 4, rowY, ellipsize(renamed, w - 4),
        mix(rowBg, isSelected ? T.fg : T.slate, rowP), rowBg,
        isSelected ? ATTR_BOLD : 0, w - 4);
    }
    state.hits.push({ kind: 'file', lane, index: fileIndex, x1: x, x2: x + w - 1, y: rowY });
  }

  // Scrollbar thumb when the list overflows.
  if (files.length > listH && w >= 3) {
    const trackH = Math.min(listH, rowsBottom - rowsTop);
    const thumbH = Math.max(1, Math.round((listH / files.length) * trackH));
    const thumbY = rowsTop + Math.round((scroll / Math.max(1, files.length - listH)) * (trackH - thumbH));
    for (let i = 0; i < trackH; i++) {
      const on = i >= thumbY - rowsTop && i < thumbY - rowsTop + thumbH;
      s.put(x + w - 1, rowsTop + i, on ? BLOCK.l4 : LIGHT.v,
        on ? mix(T.bg, tint, 0.7) : mix(T.bg, T.rule, 0.6));
    }
  }
}

function drawGate(s, state, x, y, w, h, t, p) {
  if (w < 1) return;
  const center = x + Math.floor(w / 2);
  // Use the latched direction, not the resting spring value, so the arrow keeps
  // pointing the way the last transfer moved.
  const direction = state.gateDir >= 0 ? 1 : -1;
  const flash = clamp(state.pulse?.v ?? 0, 0, 1);
  const dirTint = direction > 0 ? T.ok : T.accent2;
  for (let row = 0; row < h; row++) {
    const ry = y + row;
    if (ry >= s.h - 1) break;
    const hot = row === (Math.floor(t * 8) % Math.max(1, h));
    const glow = Math.max(hot ? 0.76 : 0.4, flash * 0.9);
    s.put(center, ry, hot || flash > 0.3 ? BLOCK.full : LIGHT.v,
      mix(T.bg, hot || flash > 0.3 ? dirTint : T.rule, p * glow));
  }
  const gy = y + Math.floor(h / 2);
  if (gy >= s.h - 1) return;
  if (w >= 5) {
    s.text(x, gy - 1, 'INDEX', mix(T.bg, T.dim, p), DEFAULT, ATTR_BOLD, w);
    const arrow = direction > 0 ? '>>>' : '<<<';
    s.text(x + Math.max(0, Math.floor((w - 3) / 2)), gy, arrow,
      mix(dirTint, T.fg, flash * 0.5), DEFAULT, ATTR_BOLD, w);
  } else {
    s.put(center, gy, direction > 0 ? MARK.arrow : MARK.arrow_l,
      mix(T.bg, flash > 0.1 ? dirTint : T.rule, p), DEFAULT, ATTR_BOLD);
  }
  state.hits.push({ kind: 'gate', x1: x, x2: x + w - 1, y: gy });
}

function drawDiff(s, state, x, y, w, h, t, p) {
  if (h <= 0 || w <= 0) return;
  const entry = state.lanes[state.lane]?.[state.selected[state.lane]];
  const kind = fileKind(entry);
  const railColor = kind === 'added' ? T.ok : kind === 'deleted' ? T.accent : T.accent2;
  const railChar = kind === 'deleted' ? DASH.v : kind === 'added' ? HEAVY.v : LIGHT.v;
  const counts = diffCounts(state.diff);

  // Header row: a status pip, the path, and a +/- tally on the right.
  s.fillRect(x, y, w, 1, ' ', T.fg, T.bg);
  s.put(x, y, MARK.tri_d, railColor, DEFAULT, ATTR_BOLD);
  const label = state.diffPath || (state.error ? 'GIT ERROR' : 'SELECT A FILE');
  const tally = ` +${counts.added} −${counts.removed} `;
  const tallyW = w > 20 ? strWidth(tally) : 0;
  const labelW = Math.max(1, w - 3 - tallyW);
  const used = s.text(x + 2, y, ellipsize(label, labelW),
    state.error ? T.accent : T.fg, DEFAULT, ATTR_BOLD, labelW);
  // Dotted leader between the path and the tally.
  for (let col = x + 3 + used; col < x + w - tallyW - 1; col++) {
    s.put(col, y, MARK.dot, mix(T.bg, T.rule, 0.7));
  }
  if (tallyW) {
    let tx = x + w - tallyW;
    tx += s.text(tx, y, ' +', mix(T.bg, T.ok, 0.5), DEFAULT, ATTR_DIM);
    tx += s.text(tx, y, String(counts.added), T.ok, DEFAULT, ATTR_BOLD);
    tx += s.text(tx, y, ' −', mix(T.bg, T.accent, 0.5), DEFAULT, ATTR_DIM);
    s.text(tx, y, String(counts.removed), T.accent, DEFAULT, ATTR_BOLD);
  }

  const rows = Math.max(0, h - 1);
  state.diffRows = rows;
  const maxScroll = Math.max(0, state.diff.length - rows);
  state.diffScroll = clamp(state.diffScroll, 0, maxScroll);
  const scrollbar = state.diff.length > rows && w >= 6;
  const contentW = scrollbar ? w - 1 : w;
  const visible = state.diff.slice(state.diffScroll, state.diffScroll + rows);
  for (let i = 0; i < visible.length; i++) {
    const line = visible[i];
    const ry = y + 1 + i;
    const color = diffColor(line.kind);
    const bg = line.kind === 'add' ? mix(T.bg, T.ok, 0.09)
      : line.kind === 'del' ? mix(T.bg, T.accent, 0.08)
        : line.kind === 'hunk' ? mix(T.bg, T.accent2, 0.06) : T.bg;
    s.fillRect(x, ry, contentW, 1, ' ', T.fg, bg);
    s.put(x, ry, railChar, mix(bg, railColor, 0.9), bg, ATTR_BOLD);
    const oldNo = line.oldLine == null ? '' : String(line.oldLine);
    const newNo = line.newLine == null ? '' : String(line.newLine);
    const numberW = contentW < 44 ? 3 : 4;
    let tx = x + 2;
    s.text(tx, ry, oldNo.padStart(numberW), mix(bg, T.dim, 0.76), bg, ATTR_DIM, numberW);
    tx += numberW + 1;
    s.text(tx, ry, newNo.padStart(numberW), mix(bg, T.dim, 0.76), bg, ATTR_DIM, numberW);
    tx += numberW + 1;
    const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-'
      : line.kind === 'hunk' ? '@' : ' ';
    s.put(tx++, ry, prefix, color, bg, ATTR_BOLD);
    if (tx < x + contentW) {
      s.text(tx, ry, ellipsize(line.text, x + contentW - tx), color, bg,
        line.kind === 'hunk' ? ATTR_BOLD : 0, x + contentW - tx);
    }
  }

  if (scrollbar) drawDiffScrollbar(s, state, x + w - 1, y + 1, rows, railColor);

  if (!visible.length && h > 1) {
    const text = state.loading ? 'reading index...'
      : state.diffLoading ? 'reading diff...'
        : state.error || (entry ? 'no textual diff' : 'choose a file from either lane');
    s.text(x + 2, y + 1, ellipsize(text, Math.max(1, w - 2)),
      state.error ? T.accent : T.dim, DEFAULT, ATTR_DIM, w - 2);
  }
}

function drawDiffScrollbar(s, state, x, y, rows, tint) {
  const total = state.diff.length;
  const thumbH = Math.max(1, Math.round((rows / total) * rows));
  const maxScroll = Math.max(1, total - rows);
  const thumbY = y + Math.round((state.diffScroll / maxScroll) * (rows - thumbH));
  for (let i = 0; i < rows; i++) {
    if (y + i >= s.h - 1) break;
    const on = y + i >= thumbY && y + i < thumbY + thumbH;
    s.put(x, y + i, on ? BLOCK.l4 : LIGHT.v,
      on ? mix(T.bg, tint, 0.72) : mix(T.bg, T.rule, 0.55));
  }
}

function drawFooter(s, state, y, p) {
  s.fillRect(0, y, s.w, 1, ' ', T.cream, T.pitch);
  const actions = [
    ['stageAll', ' A stage all ', T.ok],
    ['unstageAll', ' U unstage ', T.accent2],
    ['discard', ' D discard ', T.accent],
    ['commit', ' C commit ', T.ember],
  ];
  let x = 1;
  for (const [kind, text, tint] of actions) {
    if (x + strWidth(text) >= s.w - 10) break;
    const hovered = state.hover?.kind === kind;
    s.text(x, y, text, T.pitch, mix(T.pitch, tint, (hovered ? 1 : 0.82) * p), ATTR_BOLD);
    state.hits.push({ kind, x1: x, x2: x + strWidth(text) - 1, y });
    x += strWidth(text) + 1;
  }
  const hint = 'tab lane · ↑↓ select · space stage · pg scroll · ^k close';
  if (s.w - x > 16) s.textRight(s.w - 1, y, ellipsize(hint, s.w - x - 1), mix(T.pitch, T.cream, 0.7), T.pitch, ATTR_DIM);
}

function markColor(mark) {
  if (mark === 'A' || mark === '?') return T.ok;
  if (mark === 'D') return T.accent;
  if (mark === 'R' || mark === 'C') return T.plum;
  return T.accent2;
}

function fileKind(entry) {
  if (!entry) return 'modified';
  if (entry.mark === 'A' || entry.mark === '?') return 'added';
  if (entry.mark === 'D') return 'deleted';
  return 'modified';
}

function diffColor(kind) {
  if (kind === 'add') return T.ok;
  if (kind === 'del') return T.accent;
  if (kind === 'hunk') return T.accent2;
  if (kind === 'meta') return T.dim;
  return T.slate;
}

function diffCounts(lines) {
  let added = 0;
  let removed = 0;
  for (const line of lines ?? []) {
    if (line.kind === 'add') added++;
    if (line.kind === 'del') removed++;
  }
  return { added, removed };
}
