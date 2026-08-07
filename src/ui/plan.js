import { ATTR_BOLD, ATTR_DIM, DEFAULT, strWidth } from '../ansi.js';
import { BLOCK, HEAVY, MARK } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { clamp, ease } from '../anim.js';
import { panel, bar, shimmer } from '../draw.js';
import { ellipsize } from '../wrap.js';
import { planProgress, planShouldShow } from '../plan.js';

export const PLAN_MAX_VISIBLE = 6;

/** Stable vertical footprint reserved immediately above the composer/queue. */
export function planHeight(st, maxH = Infinity) {
  const plan = st?.plan;
  if (!planShouldShow(plan) && (plan?.anim?.target ?? 0) <= 0) return 0;
  if (plan?.expanded === false) return Math.min(3, maxH);
  const todos = plan?.todos ?? [];
  let h = 3; // frame + progress row
  if (plan?.proposal || plan?.intent) h++;
  h += Math.max(1, Math.min(PLAN_MAX_VISIBLE, todos.length));
  if (todos.length > PLAN_MAX_VISIBLE) h++;
  h++; // approval/actions or keyboard hint row
  if (plan?.approval === 'pending' && plan?.focused) h++; // editing toolbar above approval
  return clamp(h, 3, maxH);
}

export const planPanelHeight = planHeight;

export function drawPlanPanel(s, st, x, y, w, t, maxH = Infinity) {
  const plan = st?.plan;
  if (!plan || w < 20) return 0;
  const p = ease.outQuint(clamp(plan.anim?.v ?? (planShouldShow(plan) ? 1 : 0), 0, 1));
  if (p <= 0.002) {
    plan.hits = [];
    plan.geometry = null;
    return 0;
  }

  const targetH = planHeight(st, Math.min(maxH, Math.max(3, s.h - Math.max(0, y))));
  const h = Math.max(3, targetH);
  const slide = st.reduceMotion ? 0 : Math.round((1 - p) * 2);
  const py = y + slide;
  const pulse = clamp(plan.pulse?.v ?? 0, 0, 1);
  const progress = planProgress(plan);
  const bg = mix(T.cream, plan.mode === 'plan' ? T.crust : T.bg, plan.mode === 'plan' ? 0.24 : 0.12);
  const signal = plan.mode === 'plan' ? T.accent : T.accent2;
  const border = mix(T.rule, signal, 0.45 + p * 0.35 + pulse * 0.16);

  panel(s, x, py, w, h, {
    bg,
    border,
    style: HEAVY,
    shadow: true,
    shadowOff: 1,
    shadowColor: mix(T.bg, signal, 0.12 + pulse * 0.07),
    label: plan.mode === 'plan' ? 'PLAN / THINK' : 'TODO / EXECUTE',
    labelColor: signal,
  });

  plan.hits = [{ kind: 'header', x1: x, x2: x + w - 1, y: py }];
  plan.geometry = { x, y: py, w, h };

  const fold = plan.expanded === false ? MARK.tri_u : MARK.tri_d;
  const foldText = ` ${fold} `;
  const foldX = x + w - strWidth(foldText) - 1;
  s.text(foldX, py, foldText, mix(bg, signal, p), bg, ATTR_BOLD);
  plan.hits.push({ kind: 'collapse', x1: foldX, x2: x + w - 2, y: py });

  const approval = String(plan.approval ?? 'none').toUpperCase();
  const approvalColor = plan.approval === 'approved' ? T.ok
    : plan.approval === 'rejected' ? T.warn
      : plan.approval === 'pending' ? T.accent : T.dim;
  const stateChip = ` ${approval} `;
  if (foldX - strWidth(stateChip) > x + 18) {
    s.text(foldX - strWidth(stateChip) - 1, py, stateChip, T.bg,
      mix(bg, approvalColor, 0.72 + pulse * 0.18), ATTR_BOLD);
  }

  const iy = py + 1;
  const label = progress.total ? `${progress.done}/${progress.total}` : 'DRAFT';
  s.text(x + 2, iy, label, mix(bg, signal, p), bg, ATTR_BOLD);
  const notes = plan.notes ? `NOTES ${[...String(plan.notes)].length}` : 'NOTES —';
  const notesW = strWidth(notes);
  if (notesW + 17 < w) s.textRight(x + w - 3, iy, notes, mix(bg, T.plum, 0.72 * p), bg, ATTR_DIM);
  const barX = x + 2 + strWidth(label) + 2;
  const barW = Math.max(4, x + w - 4 - notesW - barX - 2);
  bar(s, barX, iy, barW, progress.total ? progress.ratio * p : 0,
    plan.approval === 'approved' ? T.ok : signal, mix(bg, T.inset, 0.86), bg);
  if (progress.total && progress.done < progress.total) shimmer(s, barX, iy, barW, t, border, signal, 10, 4);

  if (!plan.expanded) return h;

  let row = iy + 1;
  const innerW = Math.max(1, w - 6);
  const summary = String(plan.proposal || plan.intent || '').replace(/\s+/g, ' ').trim();
  if (summary && row < py + h - 1) {
    s.put(x + 1, row, BLOCK.l4, mix(bg, T.plum, p), bg, ATTR_BOLD);
    s.text(x + 3, row, ellipsize(summary, innerW), mix(bg, T.slate, p), bg, ATTR_DIM);
    plan.hits.push({ kind: 'summary', x1: x + 1, x2: x + w - 2, y: row });
    row++;
  }

  const todos = plan.todos ?? [];
  const maxStart = Math.max(0, todos.length - PLAN_MAX_VISIBLE);
  const windowStart = plan.focused
    ? clamp(plan.cursor - Math.floor(PLAN_MAX_VISIBLE / 2), 0, maxStart) : 0;
  const shown = todos.slice(windowStart, windowStart + PLAN_MAX_VISIBLE);
  if (!shown.length && row < py + h - 1) {
    s.put(x + 1, row, MARK.dia_o, mix(bg, signal, p), bg);
    s.text(x + 3, row, ellipsize('Waiting for a concrete Todo list', innerW), mix(bg, T.dim, p), bg, ATTR_DIM);
    row++;
  }

  for (let i = 0; i < shown.length && row < py + h - 1; i++, row++) {
    const todo = shown[i];
    const todoIndex = windowStart + i;
    const selected = !!plan.focused && todoIndex === plan.cursor;
    const dragging = plan.drag?.id === todo.id;
    const active = todo.status === 'in_progress';
    const done = todo.status === 'completed';
    const rowBg = dragging ? mix(bg, signal, 0.28 + pulse * 0.08)
      : selected ? mix(bg, signal, 0.16 + pulse * 0.08) : bg;
    s.fillRect(x + 1, row, w - 2, 1, ' ', T.fg, rowBg);
    const rail = dragging ? signal : done ? T.ok : active ? T.accent : selected ? signal : T.rule;
    s.put(x + 1, row, active ? BLOCK.full : BLOCK.l4, mix(rowBg, rail, p), rowBg, ATTR_BOLD);
    const mark = dragging ? MARK.tri_r : done ? MARK.check : active ? MARK.tri_r : MARK.sq_o;
    s.put(x + 3, row, mark, mix(rowBg, rail, p), rowBg, ATTR_BOLD);
    const ordinal = String(todoIndex + 1).padStart(2, '0');
    s.text(x + 5, row, ordinal, mix(rowBg, selected ? signal : T.dim, p), rowBg, ATTR_BOLD);
    const tx = x + 8;
    const detail = dragging ? ' DRAG ' : todo.note ? ' NOTE ' : '';
    const detailW = strWidth(detail);
    const detailX = x + w - 3 - detailW;
    const textEdge = detail ? detailX - 1 : x + w - 3;
    s.text(tx, row, ellipsize(todo.text, Math.max(1, textEdge - tx)),
      mix(rowBg, done ? T.dim : T.slate, p), rowBg, done ? ATTR_DIM : selected ? ATTR_BOLD : 0);
    if (detail) s.text(detailX, row, detail, mix(rowBg, dragging ? signal : T.plum, p), rowBg, ATTR_BOLD);
    plan.hits.push({ kind: 'todo', id: todo.id, index: todoIndex, x1: x + 1, x2: x + w - 2, y: row });
  }

  if (todos.length > PLAN_MAX_VISIBLE && row < py + h - 1) {
    const above = windowStart;
    const below = Math.max(0, todos.length - windowStart - shown.length);
    const overflow = [above ? `↑ ${above} above` : '', below ? `↓ ${below} below` : ''].filter(Boolean).join('  ·  ');
    s.text(x + 3, row, ellipsize(overflow, innerW), mix(bg, T.dim, p), bg, ATTR_DIM);
    row++;
  }

  const footerY = py + h - 2;
  if (plan.approval === 'pending' && plan.focused && footerY - 1 >= iy + 1) {
    drawPlanEditFooter(s, plan, x, footerY - 1, w, bg, signal, p);
  }
  if (footerY >= iy + 1) drawPlanFooter(s, plan, x, footerY, w, bg, signal, p);
  return h;
}

export const drawPlan = drawPlanPanel;

function drawPlanFooter(s, plan, x, y, w, bg, signal, p) {
  s.fillRect(x + 1, y, w - 2, 1, ' ', T.fg, mix(bg, T.inset, 0.28));
  const rowBg = mix(bg, T.inset, 0.28);
  if (plan.approval === 'pending') {
    const approve = ' Y / ↵  APPROVE ';
    const revise = ' N  REVISE ';
    const ax = x + 2;
    const rx = x + w - strWidth(revise) - 2;
    s.text(ax, y, approve, T.bg, mix(rowBg, T.ok, 0.88 * p), ATTR_BOLD);
    if (rx > ax + strWidth(approve) + 1) s.text(rx, y, revise, T.bg, mix(rowBg, T.warn, 0.78 * p), ATTR_BOLD);
    plan.hits.push({ kind: 'approve', x1: ax, x2: ax + strWidth(approve) - 1, y });
    plan.hits.push({ kind: 'reject', x1: rx, x2: rx + strWidth(revise) - 1, y });
    return;
  }

  if (plan.focused) {
    drawPlanEditFooter(s, plan, x, y, w, bg, signal, p);
    return;
  }
  s.text(x + 3, y, ellipsize('click to focus  ·  click summary to edit  ·  header hides', Math.max(1, w - 6)),
    mix(rowBg, signal, 0.64 * p), rowBg, ATTR_DIM);
}

function drawPlanEditFooter(s, plan, x, y, w, bg, signal, p) {
  const rowBg = mix(bg, T.inset, 0.28);
  s.fillRect(x + 1, y, w - 2, 1, ' ', T.fg, rowBg);
  const actions = [
    ['add', ' A ADD '],
    ['edit', ' E EDIT '],
    ['delete', ' D DEL '],
    ['move', ' ⇧↑↓ / DRAG '],
    ['summary', ' P PLAN '],
  ];
  let tx = x + 2;
  const edge = x + w - 2;
  for (const [kind, text] of actions) {
    const width = strWidth(text);
    if (tx + width > edge) break;
    const enabled = kind === 'add' || kind === 'summary' || plan.todos?.length;
    const color = kind === 'summary' ? T.plum : enabled ? signal : T.dim;
    s.text(tx, y, text, mix(rowBg, color, (enabled ? 0.76 : 0.48) * p), rowBg,
      enabled ? ATTR_BOLD : ATTR_DIM);
    if (kind !== 'move') plan.hits.push({ kind, x1: tx, x2: tx + width - 1, y });
    tx += width + 1;
  }
  const complete = 'SPACE DONE';
  if (edge - tx > strWidth(complete) + 1) {
    s.textRight(edge, y, complete, mix(rowBg, T.dim, p), rowBg, ATTR_DIM);
  }
}
