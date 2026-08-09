// Approde sidebar — a docked, full-height drawer on the right edge. It slides in
// from the right, compressing the transcript viewport (see app-interaction.js).
// Brutalist condensed-milk aesthetic: hard panel, drop shadow, stencil labels.

import { T, mix } from '../theme.js';
import { ease, clamp } from '../anim.js';
import { panel, rule, ruleFade, shimmer, badge } from '../draw.js';
import { MARK, HEAVY } from '../glyphs.js';
import {
  approdeRows, isNavigable, canShowApprode, APPRODE_MIN_W, APPRODE_MAX_W,
  APPRODE_TRANSCRIPT_MIN_W,
} from '../approde.js';
import { ellipsize } from '../wrap.js';

/** Current animated width the drawer occupies, in columns. 0 when hidden. */
export function approdeWidth(state, screenW) {
  if (!state) return 0;
  const p = state.anim?.v ?? 0;
  if (p <= 0.002) return 0;
  if (!canShowApprode(screenW)) return 0;
  const room = Math.max(0, screenW - APPRODE_TRANSCRIPT_MIN_W);
  const target = clamp(APPRODE_MAX_W, APPRODE_MIN_W, room);
  return Math.round(target * ease.outCubic(p));
}

/**
 * @param vp viewport from App#viewport() — the drawer aligns with the transcript
 *   band it displaced, so the composer/plan/queue stack keeps its full width.
 */
export function drawApprode(s, st, t, vp) {
  const state = st.approde;
  const p = state?.anim?.v ?? 0;
  if (!state || p <= 0.002) { if (state) { state.hits = []; state.geometry = null; } return; }

  const w = approdeWidth(state, s.w);
  if (w < APPRODE_MIN_W) { state.hits = []; state.geometry = null; return; }

  const h = Math.max(6, vp?.h ?? s.h - 6);
  const x = s.w - w;
  const y = vp?.y ?? 3;

  state.hits = [];
  state.geometry = { x, y, w, h };

  const focused = state.focused;
  const border = focused ? T.accent : T.rule;
  const labelColor = focused ? T.accent : T.dim;

  // Drop shadow to the left so the drawer reads as lifted off the transcript.
  if (x - 1 >= 0) {
    const sh = mix(T.bg, T.shadow, 0.3);
    for (let yy = y; yy < y + h; yy++) s.tint(x - 1, yy, mix(T.dim, T.shadow, 0.4), sh);
  }

  panel(s, x, y, w, h, {
    bg: T.panel, border, style: HEAVY, shadow: false,
    label: 'APPRODE', labelColor, labelBg: T.panel,
  });

  const innerX = x + 2;
  const innerW = w - 4;
  let cy = y + 1;

  // Header strip: title + subtitle + close affordance.
  s.text(innerX, cy, 'HOT-SWAP', focused ? T.accent : T.fg);
  const closeLabel = `${MARK.cross}`;
  s.text(x + w - 3, cy, closeLabel, T.dim);
  state.hits.push({ kind: 'close', x1: x + w - 3, x2: x + w - 2, y1: cy, y2: cy });
  cy++;
  s.text(innerX, cy, ellipsize('skills & prompts, live', innerW), T.dim);
  cy++;
  if (focused) shimmer(s, innerX, cy, innerW, t, T.rule, T.accent, 1.4, 6);
  else rule(s, innerX, cy, innerW, T.rule);
  cy++;

  // Derive the navigable subset from *these* row objects — approdeRows() builds
  // fresh objects each call, so a second navigableRows(state) would never match
  // by identity and every hit would lose its cursor index.
  const rows = approdeRows(state);
  const nav = rows.filter(isNavigable);
  const navIndexOf = (row) => nav.indexOf(row);

  const listTop = cy;
  const listBottom = y + h - 3; // leave two lines for the footer
  const listH = Math.max(1, listBottom - listTop);

  // Keep the cursor row inside the viewport.
  const cursorRowLine = rowLineIndex(rows, state.index, nav);
  if (cursorRowLine < state.scroll) state.scroll = cursorRowLine;
  else if (cursorRowLine >= state.scroll + listH) state.scroll = cursorRowLine - listH + 1;
  state.scroll = clamp(state.scroll, 0, Math.max(0, rows.length - listH));

  let line = 0;
  for (let i = 0; i < rows.length; i++) {
    const rowLine = line;
    line++;
    if (rowLine < state.scroll) continue;
    const drawY = listTop + (rowLine - state.scroll);
    if (drawY >= listBottom) break;
    drawRow(s, state, rows[i], innerX, drawY, innerW, navIndexOf(rows[i]), focused, t);
  }

  // Scrollbar hint when the list overflows.
  if (rows.length > listH) {
    const trackH = listH;
    const thumb = Math.max(1, Math.round((listH / rows.length) * trackH));
    const thumbY = listTop + Math.round((state.scroll / Math.max(1, rows.length - listH)) * (trackH - thumb));
    for (let yy = listTop; yy < listBottom; yy++) {
      const on = yy >= thumbY && yy < thumbY + thumb;
      s.put(x + w - 2, yy, on ? MARK.bar : MARK.dot, on ? (focused ? T.accent : T.dim) : T.rule, T.panel);
    }
  }

  // Footer: state summary + key hints, or the save prompt.
  const footY = y + h - 2;
  ruleFade(s, innerX, footY - 1, innerW, T.rule);
  if (state.mode === 'save') {
    drawSavePrompt(s, state, innerX, footY, innerW, t);
  } else {
    const onS = countEnabled(state.catalog.skills, state.disabledSkills);
    const onP = countEnabled(state.catalog.prompts, state.disabledPrompts);
    const summary = `${onS.on}/${onS.total} skills · ${onP.on}/${onP.total} prompts`;
    s.text(innerX, footY, ellipsize(summary, innerW), T.dim);
    const label = ellipsize(state.applying
      ? 'applying'
      : state.activePreset || (state.dirty ? 'unsaved' : 'custom'), 18);
    const badgeW = label.length + 2;
    badge(s, Math.max(innerX, x + w - 2 - badgeW), footY, label,
      T.bg, state.applying ? T.accent : state.dirty ? T.warn : T.ok);
  }
}

function drawRow(s, state, row, x, y, w, navIndex, focused, t) {
  const selected = navIndex >= 0 && navIndex === state.index;
  const pulse = selected ? (state.pulse?.v ?? 0) : 0;

  if (row.kind === 'section') {
    if (row.label) s.text(x, y, ellipsize(row.label, w), T.dim);
    else rule(s, x, y, w, T.rule);
    return;
  }
  if (row.kind === 'empty') {
    s.text(x + 2, y, ellipsize(row.label, w - 2), mix(T.dim, T.bg, 0.3));
    return;
  }

  if (selected) {
    const bg = mix(T.inset, focused ? T.accent : T.dim, 0.12 + 0.18 * pulse);
    s.fillRect(x - 1, y, w + 2, 1, ' ', T.fg, bg);
    s.put(x - 1, y, MARK.caret, focused ? T.accent : T.dim, bg);
  }
  const rowBg = selected ? mix(T.inset, focused ? T.accent : T.dim, 0.12) : T.panel;

  if (row.kind === 'preset') {
    const glyph = row.active ? MARK.diamond : MARK.dia_o;
    s.put(x, y, glyph, row.active ? T.ok : T.dim, rowBg);
    s.text(x + 2, y, ellipsize(row.name, w - 4), selected ? T.fg : mix(T.fg, T.dim, 0.15), rowBg);
    // trailing delete affordance
    s.put(x + w - 1, y, MARK.cross, mix(T.dim, T.warn, selected ? 0.5 : 0.15), rowBg);
    // The row activates the preset; the trailing cross is a narrow delete hitbox
    // laid down last so reverse hit-testing prefers it.
    pushHit(state, row, navIndex, x - 1, x + w, y);
    state.hits.push({ kind: 'delete', navIndex, deletePreset: row.name, x1: x + w - 1, x2: x + w, y1: y, y2: y });
    return;
  }

  if (row.kind === 'skill' || row.kind === 'prompt') {
    const box = row.enabled ? MARK.check : MARK.sq_o;
    const boxColor = row.enabled ? T.ok : mix(T.dim, T.bg, 0.2);
    s.put(x, y, box, boxColor, rowBg);
    const nameColor = row.enabled ? (selected ? T.fg : mix(T.fg, T.dim, 0.1)) : mix(T.dim, T.bg, 0.35);
    const name = ellipsize(row.name, w - 3);
    s.text(x + 2, y, name, nameColor, rowBg);
    pushHit(state, row, navIndex, x - 1, x + w, y);
    return;
  }

  if (row.kind === 'action') {
    const glyph = row.action === 'apply' ? MARK.tri_r : row.action === 'reset' ? MARK.ring : MARK.star;
    const tone = row.action === 'apply' ? T.accent : row.action === 'reset' ? T.dim : T.accent2;
    s.put(x, y, glyph, tone, rowBg);
    s.text(x + 2, y, ellipsize(row.label, w - 3), selected ? T.fg : mix(T.fg, T.dim, 0.1), rowBg);
    pushHit(state, row, navIndex, x - 1, x + w, y);
    return;
  }
}

function drawSavePrompt(s, state, x, y, w, t) {
  s.text(x, y, 'name:', T.accent);
  const fieldX = x + 6;
  const fieldW = Math.max(4, w - 6);
  s.fillRect(fieldX, y, fieldW, 1, ' ', T.fg, T.inset);
  const value = ellipsize(state.saveName || '', fieldW - 1);
  s.text(fieldX, y, value, T.fg, T.inset);
  const caretX = fieldX + Math.min(fieldW - 1, [...(state.saveName || '')].slice(0, state.saveCursor).length);
  if (Math.floor(t * 2) % 2 === 0) s.put(caretX, y, MARK.bar, T.accent, T.inset);
}

function pushHit(state, row, navIndex, x1, x2, y, extra = {}) {
  state.hits.push({ kind: row.kind, navIndex, x1, x2, y1: y, y2: y, ...extra });
}

function rowLineIndex(rows, navIndex, nav) {
  const target = nav[navIndex];
  if (!target) return 0;
  return Math.max(0, rows.indexOf(target));
}

function countEnabled(items, disabled) {
  const total = items.length;
  let on = 0;
  for (const item of items) if (!disabled.has(item.name)) on++;
  return { on, total };
}
