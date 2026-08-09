import { ATTR_BOLD, ATTR_DIM, strWidth } from '../ansi.js';
import { HEAVY, LIGHT, MARK } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { clamp, ease } from '../anim.js';
import { panel, shimmer } from '../draw.js';
import { effortDescription } from '../effort-picker.js';
import { ellipsize } from '../wrap.js';

export function effortPickerLayout(w, h, state, p = 1) {
  const pw = clamp(Math.min(80, w - 4), 20, Math.max(20, w - 2));
  const ph = Math.min(9, Math.max(7, h - 2));
  const reveal = ease.outBack(clamp(p, 0, 1));
  const px = Math.max(0, Math.floor((w - pw) / 2));
  const restY = Math.max(0, Math.floor((h - ph) / 2));
  const py = clamp(restY + Math.round((1 - reveal) * 3), 0, Math.max(0, h - ph));
  const compact = pw < 48;
  const trackX1 = px + (compact ? 3 : 5);
  const trackX2 = px + pw - (compact ? 4 : 6);
  const count = Math.max(1, state?.options?.length ?? 1);
  const positions = Array.from({ length: count }, (_, i) => count === 1
    ? Math.round((trackX1 + trackX2) / 2)
    : Math.round(trackX1 + ((trackX2 - trackX1) * i) / (count - 1)));
  return { px, py, pw, ph, compact, trackX1, trackX2, positions, reveal };
}

export function drawEffortPicker(s, st, t) {
  const state = st?.effortPicker;
  if (!state) return null;
  const p = clamp(state.anim?.v ?? (state.open ? 1 : 0), 0, 1);
  if (p <= 0.002) {
    state.hits = [];
    state.geometry = null;
    return null;
  }
  s.clearCursorAnchor();
  const g = effortPickerLayout(s.w, s.h, state, p);
  const wash = ease.outCubic(p);
  const veil = mix(T.bg, T.shadow, 0.09);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      s.fg[i] = mix(s.fg[i] < 0 ? T.fg : s.fg[i], veil, wash);
      s.bg[i] = mix(s.bg[i] < 0 ? T.bg : s.bg[i], veil, wash);
    }
  }

  const { px, py, pw, ph, compact, trackX1, trackX2, positions } = g;
  const pulse = clamp(state.pulse?.v ?? 0, 0, 1);
  const bg = mix(T.cream, T.bg, 0.06);
  const border = mix(T.rule, T.accent, 0.6 + pulse * 0.18);
  panel(s, px, py, pw, ph, {
    bg,
    border,
    style: HEAVY,
    shadow: true,
    shadowOff: 2,
    shadowColor: mix(T.bg, T.pitch, 0.38 * p),
    label: 'EFFORT / LEVEL',
    labelColor: T.accent,
  });
  state.hits = [];
  state.geometry = { x: px, y: py, w: pw, h: ph };

  const cancel = ` ${MARK.cross} `;
  const cancelX = px + pw - strWidth(cancel) - 2;
  s.text(cancelX, py, cancel, T.bg, mix(bg, T.accent, 0.78), ATTR_BOLD);
  state.hits.push({ kind: 'cancel', x1: cancelX, x2: cancelX + strWidth(cancel) - 1, y1: py, y2: py });

  const selected = state.options[state.index] ?? '';
  const current = state.options[state.currentIndex] ?? '';
  const metaY = py + 1;
  const currentText = compact ? `NOW ${current}` : `CURRENT · ${current}`;
  const previewText = compact ? `TRY ${selected}` : `PREVIEW · ${selected}`;
  const metaW = Math.max(8, pw - 6);
  const previewW = compact
    ? Math.min(strWidth(previewText) + 2, Math.max(7, metaW - 7))
    : Math.min(strWidth(previewText) + 2, Math.max(4, Math.floor(metaW * 0.46)));
  const previewX = px + pw - previewW - 3;
  const currentW = Math.max(4, previewX - (px + 3) - 1);
  s.text(px + 3, metaY, ellipsize(currentText, currentW),
    mix(bg, T.slate, p), bg, ATTR_BOLD);
  const previewLabel = ellipsize(` ${previewText} `, previewW);
  s.text(previewX, metaY, previewLabel, T.bg, mix(bg, T.accent, 0.88), ATTR_BOLD, previewW);

  const directionY = py + 2;
  s.text(trackX1, directionY, compact ? 'FAST' : 'FASTER / QUICK', mix(bg, T.accent2, p), bg, ATTR_BOLD);
  const smart = compact ? 'DEEP' : 'SMARTER / DEEP';
  s.textRight(trackX2 + 1, directionY, smart, mix(bg, T.plum, p), bg, ATTR_BOLD);
  if (!compact) {
    const axis = 'RESPONSE  ↔  REASONING';
    const axisX = Math.floor((s.w - strWidth(axis)) / 2);
    if (axisX > trackX1 + 15 && axisX + strWidth(axis) < trackX2 - 14) {
      s.text(axisX, directionY, axis, mix(bg, T.dim, p), bg, ATTR_DIM);
    }
  }

  const trackY = py + 3;
  const cursor = clamp(state.cursor?.v ?? state.index, 0, Math.max(0, state.options.length - 1));
  const cursorX = state.options.length <= 1 ? positions[0]
    : Math.round(trackX1 + ((trackX2 - trackX1) * cursor) / (state.options.length - 1));
  for (let x = trackX1; x <= trackX2; x++) {
    const active = x <= cursorX;
    const color = active
      ? mix(bg, T.accent, 0.58 + 0.3 * p)
      : mix(bg, T.rule, 0.82);
    s.put(x, trackY, active ? HEAVY.h : LIGHT.h, color, bg, active ? ATTR_BOLD : 0);
  }
  for (const x of positions) s.put(x, trackY, LIGHT.cross, mix(bg, T.slate, 0.72), bg, ATTR_BOLD);
  const currentX = positions[state.currentIndex] ?? cursorX;
  s.put(currentX, trackY, MARK.dia_o, mix(bg, T.slate, p), bg, ATTR_BOLD);
  s.put(cursorX, trackY, MARK.diamond, mix(bg, T.accent, 0.9 + pulse * 0.1), bg, ATTR_BOLD);

  const labelY = py + 4;
  const spacing = positions.length > 1 ? positions[1] - positions[0] : trackX2 - trackX1;
  const longest = Math.max(1, ...state.options.map((option) => strWidth(option)));
  const showAll = !compact && spacing >= longest + 2;
  if (showAll) {
    for (let i = 0; i < state.options.length; i++) {
      const option = state.options[i];
      const isSelected = i === state.index;
      const tx = clamp(positions[i] - Math.floor(strWidth(option) / 2), px + 2, px + pw - strWidth(option) - 2);
      s.text(tx, labelY, option,
        isSelected ? T.bg : mix(bg, i === state.currentIndex ? T.slate : T.dim, p),
        isSelected ? mix(bg, T.accent, 0.88) : bg,
        isSelected || i === state.currentIndex ? ATTR_BOLD : ATTR_DIM);
    }
  } else {
    const label = ` ${selected} `;
    s.text(Math.floor((s.w - strWidth(label)) / 2), labelY, label, T.bg,
      mix(bg, T.accent, 0.86), ATTR_BOLD);
  }

  const labelHitY1 = Math.max(py + 1, trackY - 1);
  for (let i = 0; i < positions.length; i++) {
    const left = i === 0 ? trackX1 - 1 : Math.floor((positions[i - 1] + positions[i]) / 2) + 1;
    const right = i === positions.length - 1 ? trackX2 + 1 : Math.floor((positions[i] + positions[i + 1]) / 2);
    state.hits.push({ kind: 'option', index: i, x1: left, x2: right, y1: labelHitY1, y2: labelY });
  }

  const footerY = py + ph - 2;
  if (ph >= 8) {
    const desc = `${MARK.star} ${effortDescription(selected)}`;
    s.text(px + 3, py + 5, ellipsize(desc, pw - 6), mix(bg, T.fg, p), bg, ATTR_DIM);
  }
  const hint = compact ? '← →' : '← →  PREVIEW';
  s.text(px + 3, footerY, hint, mix(bg, T.dim, p), bg, ATTR_DIM);
  const apply = compact ? ' APPLY ' : ` ${MARK.check} APPLY `;
  const applyX = px + pw - strWidth(apply) - 3;
  s.text(applyX, footerY, apply, T.bg, mix(bg, T.accent2, 0.9), ATTR_BOLD);
  state.hits.push({ kind: 'apply', x1: applyX, x2: applyX + strWidth(apply) - 1, y1: footerY, y2: footerY });

  if (state.open) shimmer(s, px + 1, py + ph - 1, pw - 2, t, border, T.accent, 14, 6);
  return g;
}
