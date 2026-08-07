import { ATTR_BOLD, ATTR_DIM, DEFAULT, strWidth } from '../ansi.js';
import { clamp, ease } from '../anim.js';
import { BLOCK, DASH, HEAVY, LIGHT, MARK, SPIN_BRAILLE } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { ellipsize } from '../wrap.js';

export function drawGit(s, st, t) {
  const state = st.git;
  const p = clamp(state?.anim?.v ?? 0, 0, 1);
  if (!state || p <= 0.001) return;
  state.hits = [];

  const reveal = ease.outCubic(p);
  const startX = Math.round((1 - reveal) * Math.min(16, s.w));
  s.fillRect(0, 0, s.w, s.h, ' ', T.fg, T.bg);
  drawTopBar(s, state, t, startX);

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

function drawTopBar(s, state, t, shift) {
  s.fillRect(0, 0, s.w, 1, ' ', T.bg, T.pitch);
  const compact = s.w < 44;
  const title = compact ? ' GIT ' : ' GIT / WORKBENCH ';
  const close = compact ? ' × ' : ' ESC× ';
  const refresh = state.loading
    ? ` ${SPIN_BRAILLE[Math.floor(t * 12) % SPIN_BRAILLE.length]} `
    : compact ? ' ↻ ' : ' R↻ ';
  const closeX = Math.max(0, s.w - strWidth(close));
  const refreshX = Math.max(0, closeX - strWidth(refresh));
  s.text(shift, 0, title, T.pitch, T.ok, ATTR_BOLD, s.w - shift);
  let x = shift + strWidth(title) + 1;
  const branch = `${MARK.diamond} ${state.branch.name}`;
  const branchRoom = Math.max(0, refreshX - x - 1);
  if (branchRoom > 0) x += s.text(x, 0, ellipsize(branch, branchRoom), T.cream, T.pitch, ATTR_BOLD, branchRoom) + 1;
  if (!compact && state.branch.ahead && x < refreshX - 2) x += s.text(x, 0, `↑${state.branch.ahead} `, T.ok, T.pitch, ATTR_BOLD);
  if (!compact && state.branch.behind && x < refreshX - 2) s.text(x, 0, `↓${state.branch.behind}`, T.warn, T.pitch, ATTR_BOLD);

  s.text(refreshX, 0, refresh, T.pitch, T.ember, ATTR_BOLD);
  s.text(closeX, 0, close, T.bg, T.accent, ATTR_BOLD);
  state.hits.push({ kind: 'refresh', x1: refreshX, x2: closeX - 2, y: 0 });
  state.hits.push({ kind: 'close', x1: closeX, x2: s.w - 1, y: 0 });

  if (s.h < 14) return;
  let railX = shift + 1;
  for (let i = 0; i < state.commits.length && railX < s.w - 5; i++) {
    const commit = state.commits[i];
    const node = i === 0 ? '◉' : '●';
    s.put(railX, 1, node, i === 0 ? T.accent : mix(T.bg, T.slate, 0.76), DEFAULT, ATTR_BOLD);
    railX += 2;
    const room = Math.min(24, s.w - railX - 2);
    railX += s.text(railX, 1, ellipsize(`${commit.hash} ${commit.subject}`, room),
      i === 0 ? T.fg : T.dim, DEFAULT, i === 0 ? ATTR_BOLD : ATTR_DIM, room);
    if (i < state.commits.length - 1 && railX < s.w - 2) {
      s.put(railX++, 1, HEAVY.h, mix(T.bg, T.rule, 0.8));
    }
  }
}

function drawLane(s, state, lane, x, y, w, listH, p) {
  if (w < 1 || x >= s.w) return;
  const active = state.lane === lane;
  const title = lane === 0 ? 'WORKTREE' : 'STAGED';
  const files = state.lanes[lane] ?? [];
  const count = String(files.length).padStart(2, '0');
  const bg = active ? mix(T.bg, lane === 0 ? T.accent2 : T.ok, 0.14) : T.bg;
  s.fillRect(x, y, w, 1, ' ', T.fg, bg);
  s.put(x, y, active ? BLOCK.full : BLOCK.l2, active ? (lane === 0 ? T.accent2 : T.ok) : T.rule, bg);
  s.text(x + 2, y, ellipsize(title, Math.max(1, w - 7)), active ? T.fg : T.slate, bg, ATTR_BOLD);
  if (w >= 5) s.textRight(x + w - 1, y, count, active ? T.fg : T.dim, bg, ATTR_BOLD);

  const selected = state.selected[lane] ?? 0;
  state.laneScroll ??= [0, 0];
  let scroll = clamp(state.laneScroll[lane] ?? 0, 0, Math.max(0, files.length - listH));
  if (selected < scroll) scroll = selected;
  if (selected >= scroll + listH) scroll = selected - listH + 1;
  state.laneScroll[lane] = scroll;
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
    const rowBg = isSelected ? mix(T.bg, lane === 0 ? T.accent2 : T.ok, 0.2) : T.bg;
    s.fillRect(x, rowY, w, 1, ' ', T.fg, rowBg);
    const color = markColor(file.mark);
    const mark = file.mark === '?' ? '+' : file.mark;
    s.text(x + 1, rowY, mark.padEnd(2), mix(T.bg, color, rowP), rowBg, ATTR_BOLD, Math.min(2, w - 1));
    if (w > 4) {
      const renamed = file.originalPath ? `${file.originalPath} ${MARK.arrow} ${file.path}` : file.path;
      s.text(x + 4, rowY, ellipsize(renamed, w - 4), mix(rowBg, isSelected ? T.fg : T.slate, rowP), rowBg,
        isSelected ? ATTR_BOLD : 0, w - 4);
    }
    state.hits.push({ kind: 'file', lane, index: fileIndex, x1: x, x2: x + w - 1, y: rowY });
  }
}

function drawGate(s, state, x, y, w, h, t, p) {
  if (w < 1) return;
  const center = x + Math.floor(w / 2);
  const pulse = Math.abs(state.gate.v);
  const direction = state.gate.v >= 0 ? 1 : -1;
  for (let row = 0; row < h; row++) {
    const ry = y + row;
    const hot = row === (Math.floor(t * 8) % Math.max(1, h));
    s.put(center, ry, hot ? BLOCK.full : LIGHT.v,
      mix(T.bg, hot ? T.accent : T.rule, p * (hot ? 0.76 : 0.48)));
  }
  const gy = y + Math.floor(h / 2);
  if (w >= 5) {
    s.text(x, gy - 1, 'INDEX', mix(T.bg, T.dim, p), DEFAULT, ATTR_BOLD, w);
    const arrow = direction > 0 ? '>>>' : '<<<';
    s.text(x + Math.max(0, Math.floor((w - 3) / 2)), gy, arrow,
      mix(T.accent2, T.ok, direction > 0 ? 0.72 : 0.18), DEFAULT, ATTR_BOLD, w);
  } else {
    s.put(center, gy, direction > 0 ? MARK.arrow : MARK.arrow_l, mix(T.bg, pulse > 0.02 ? T.accent : T.ok, p), DEFAULT, ATTR_BOLD);
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
  s.put(x, y, MARK.tri_d, railColor, DEFAULT, ATTR_BOLD);
  const label = state.diffPath || (state.error ? 'GIT ERROR' : 'SELECT A FILE');
  s.text(x + 2, y, ellipsize(label, Math.max(1, w - 18)), T.fg, DEFAULT, ATTR_BOLD, Math.max(1, w - 18));
  if (w > 20) s.textRight(x + w - 1, y, `+${counts.added} -${counts.removed}`, T.dim, DEFAULT, ATTR_BOLD);
  for (let col = x; col < x + w; col++) {
    if (col > x + 2 + Math.min(strWidth(label), Math.max(1, w - 18)) && col < x + w - 10) {
      s.put(col, y, LIGHT.h, mix(T.bg, T.rule, p * 0.44));
    }
  }

  const rows = Math.max(0, h - 1);
  const maxScroll = Math.max(0, state.diff.length - rows);
  state.diffScroll = clamp(state.diffScroll, 0, maxScroll);
  const visible = state.diff.slice(state.diffScroll, state.diffScroll + rows);
  for (let i = 0; i < visible.length; i++) {
    const line = visible[i];
    const ry = y + 1 + i;
    const color = diffColor(line.kind);
    const bg = line.kind === 'add' ? mix(T.bg, T.ok, 0.09)
      : line.kind === 'del' ? mix(T.bg, T.accent, 0.08) : T.bg;
    s.fillRect(x, ry, w, 1, ' ', T.fg, bg);
    s.put(x, ry, railChar, mix(bg, railColor, 0.9), bg, ATTR_BOLD);
    const oldNo = line.oldLine == null ? '' : String(line.oldLine);
    const newNo = line.newLine == null ? '' : String(line.newLine);
    const numberW = w < 44 ? 3 : 4;
    let tx = x + 2;
    s.text(tx, ry, oldNo.padStart(numberW), mix(bg, T.dim, 0.76), bg, ATTR_DIM, numberW);
    tx += numberW + 1;
    s.text(tx, ry, newNo.padStart(numberW), mix(bg, T.dim, 0.76), bg, ATTR_DIM, numberW);
    tx += numberW + 1;
    const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'hunk' ? '@' : ' ';
    s.put(tx++, ry, prefix, color, bg, ATTR_BOLD);
    if (tx < x + w) s.text(tx, ry, ellipsize(line.text, x + w - tx), color, bg,
      line.kind === 'hunk' ? ATTR_BOLD : 0, x + w - tx);
  }
  if (!visible.length && h > 1) {
    const text = state.loading ? 'reading index...' : state.error || (entry ? 'no textual diff' : 'choose a file from either lane');
    s.text(x + 2, y + 1, ellipsize(text, Math.max(1, w - 2)), state.error ? T.accent : T.dim, DEFAULT, ATTR_DIM, w - 2);
  }
}

function drawFooter(s, state, y, p) {
  s.fillRect(0, y, s.w, 1, ' ', T.cream, T.pitch);
  const actions = [
    ['stageAll', ' A+ ALL '],
    ['unstageAll', ' U- ALL '],
    ['commit', ' C COMMIT '],
  ];
  let x = 1;
  for (const [kind, text] of actions) {
    const bg = kind === 'stageAll' ? T.ok : kind === 'unstageAll' ? T.accent2 : T.accent;
    if (x + strWidth(text) >= s.w) break;
    s.text(x, y, text, T.pitch, mix(T.pitch, bg, 0.88 * p), ATTR_BOLD);
    state.hits.push({ kind, x1: x, x2: x + strWidth(text) - 1, y });
    x += strWidth(text) + 1;
  }
  const hint = 'tab lane  ↑↓ select  space transfer  pg diff  ^k close';
  if (s.w - x > 14) s.textRight(s.w - 1, y, ellipsize(hint, s.w - x - 1), T.cream, T.pitch, ATTR_DIM);
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
