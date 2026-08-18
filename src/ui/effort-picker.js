import { ATTR_BOLD, ATTR_DIM, strWidth } from '../ansi.js';
import { HEAVY, LIGHT, MARK } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { clamp, ease } from '../anim.js';
import { panel, shimmer } from '../draw.js';
import { effortDescription } from '../effort-picker.js';
import { ellipsize } from '../wrap.js';

export function effortPickerLayout(w, h, state, p = 1) {
  const pw = clamp(Math.min(80, w - 4), 20, Math.max(20, w - 2));
  const selected = String(state?.options?.[state?.index] ?? '').toLowerCase();
  const ph = ['xhigh', 'max'].includes(selected)
    ? Math.min(18, Math.max(9, h - 2))
    : Math.min(9, Math.max(7, h - 2));
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

const mod = (n, m) => ((n % m) + m) % m;
const cosmicLevel = (value) => ['high', 'xhigh', 'max'].includes(String(value).toLowerCase());

function spectrumColor(position) {
  const stops = [T.accent2, T.ok, T.amber, T.ember, T.accent, T.plum];
  const scaled = clamp(position, 0, 1) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  return mix(stops[i], stops[i + 1], scaled - i);
}

function drawSpectrum(s, x1, x2, y, cursor, count, t, moving, reduceMotion, bg, p) {
  const width = Math.max(1, x2 - x1);
  const progress = count <= 1 ? 1 : clamp(cursor / (count - 1), 0, 1);
  const fill = reduceMotion ? 1 : progress;
  const scan = moving && !reduceMotion ? mod(t * 0.18, 1.16) - 0.08 : -1;
  for (let x = x1; x <= x2; x++) {
    const position = (x - x1) / width;
    const active = position <= fill;
    const lead = active ? clamp(1 - Math.abs(position - fill) / 0.09, 0, 1) : 0;
    const sweep = active ? clamp(1 - Math.abs(position - scan) / 0.075, 0, 1) : 0;
    let color = mix(bg, spectrumColor(position), active ? 0.62 + 0.24 * p : 0.32);
    color = mix(color, T.cream, lead * 0.18 + sweep * 0.16);
    s.put(x, y, active ? HEAVY.h : LIGHT.h, color, bg, active ? ATTR_BOLD : 0);
  }
  return progress;
}

function noise(x, y, salt = 0) {
  let n = Math.imul(x + 31 + salt * 17, 0x45d9f3b) ^ Math.imul(y + 11, 0x27d4eb2d);
  n ^= n >>> 16;
  return n >>> 0;
}

function paintSky(s, x, y, w, h, t, moving, bg, storm = false) {
  if (w <= 0 || h <= 0) return;
  const phase = moving ? Math.floor(t * 8) : 0;
  const dim = mix(T.slate, T.cream, 0.42);
  const bright = mix(T.cream, T.bg, 0.25);
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const n = noise(col, row);
    const twinkle = moving ? mod(phase + col * 3 + row * 5, 7) : 0;
    if (n % 29 === 0) s.put(x + col, y + row, twinkle === 0 ? MARK.star : MARK.dot,
      twinkle === 0 ? bright : dim, bg, ATTR_BOLD);
    else s.put(x + col, y + row, ' ', bg, bg);
  }
  if (!storm) return;
  for (let i = 0; i < Math.max(2, Math.floor(w / 25)); i++) {
    const flight = moving ? Math.floor(t * (2 + mod(i * 3, 4))) : 0;
    const period = w + 12 + i * 7;
    const headX = x + mod(i * 29 + flight, period) - 6;
    const headY = y + mod(i * 3 + Math.floor(flight / (9 + i * 2)), h);
    for (let tail = 0; tail < 7 + mod(i * 5, 5); tail++) {
      const mx = headX - tail; const my = headY - Math.floor(tail / 4);
      if (mx < x || mx >= x + w || my < y || my >= y + h) continue;
      s.put(mx, my, tail === 0 ? MARK.star : (tail % 4 === 0 ? '╲' : '╌'),
        tail === 0 ? bright : (tail < 3 ? mix(T.cream, T.slate, 0.3) : dim), bg, tail === 0 ? ATTR_BOLD : 0);
    }
  }
  for (let i = 0; i < Math.max(4, Math.floor(w / 16)); i++) {
    const drift = moving ? Math.floor(t * (1 + mod(i, 3))) : 0;
    const ex = x + mod(i * 17 + drift, w); const ey = y + mod(i * 5 + Math.floor(drift / 2), h);
    s.put(ex, ey, ['·', '•', '✧'][mod(i, 3)], [T.ember, T.accent, T.cream][mod(i, 3)], bg, i % 3 === 2 ? ATTR_BOLD : 0);
  }
}

function paintOcean(s, x, y, w, h, t, moving) {
  if (w <= 0 || h <= 0) return;
  const water = mix(T.pitch, T.teal, 0.38);
  const deep = mix(T.pitch, T.teal, 0.2);
  const foam = mix(T.cream, T.teal, 0.38);
  const surface = moving ? t : 0;
  const horizons = [
    { offset: 0, phase: 0.15, fill: mix(T.pitch, T.teal, 0.24), tone: mix(T.pitch, T.teal, 0.72) },
    { offset: 1, phase: 1.9, fill: mix(T.pitch, T.teal, 0.36), tone: mix(T.teal, T.cream, 0.34) },
    { offset: 2, phase: 3.5, fill: mix(T.pitch, T.teal, 0.48), tone: mix(T.cream, T.teal, 0.56) },
  ];
  const rowAt = (col, layer) => clamp(Math.round(layer.offset + 0.8
    + Math.sin((col - surface * 1.25) / 5.4 + layer.phase) * 0.7
    + Math.sin((col - surface * 1.25) / 12.5 + layer.phase * 1.8) * 0.5), 0, h - 1);
  for (let col = 0; col < w; col++) {
    const boundaries = horizons.map((layer) => rowAt(col, layer));
    for (let row = Math.min(...boundaries); row < h; row++) {
      let fill = deep; for (let layer = 0; layer < horizons.length; layer++) if (row >= boundaries[layer]) fill = horizons[layer].fill;
      const texture = row >= Math.min(4, h) && noise(col, row, 73) % 11 === 0;
      s.put(x + col, y + row, texture ? '░' : ' ', mix(fill, T.cream, 0.18), texture ? mix(fill, deep, 0.32) : fill);
    }
  }
  for (const layer of horizons) for (let col = 0; col < w; col++) {
    const row = rowAt(col, layer); const next = rowAt(Math.min(w - 1, col + 1), layer);
    s.put(x + col, y + row, next > row ? '╲' : next < row ? '╱' : '~', layer.tone, layer.fill, ATTR_BOLD);
  }
  for (let row = Math.min(4, h); row < h; row++) {
    const direction = row % 2 ? -1 : 1; const span = 17 + mod(row * 3, 7); const len = 4 + mod(row, 4);
    const first = mod(row * 7 + direction * Math.floor(surface * (1 + mod(row, 3))), span) - span;
    for (let start = first; start < w + len; start += span) for (let part = 0; part < len; part++) {
      const col = start + part; if (col >= 0 && col < w) s.put(x + col, y + row, part === 0 || part === len - 1 ? '~' : '≈', mix(T.teal, T.cream, 0.42), water);
    }
    const cx = Math.floor(w * 0.66) + Math.round(Math.sin(surface * 0.9 + row * 0.7) * 2);
    const radius = Math.max(1, Math.floor((row + 2) / 2));
    for (let col = Math.max(0, cx - radius); col <= Math.min(w - 1, cx + radius); col++) {
      if (mod(col - direction * Math.floor(surface * (1 + mod(row, 2))) + row * 2, 5) !== 0) s.put(x + col, y + row, mod(col + row, 2) ? '░' : '▒', foam, water, ATTR_BOLD);
    }
  }
}

function drawCosmicLabel(s, x, y, value, t, moving) {
  const phase = moving ? Math.floor(t * 10) : 0;
  for (let i = 0; i < value.length; i++) s.put(x + i, y, value[i],
    mod(phase + i * 3, 5) !== 0 ? mix(T.cream, T.bg, 0.28) : mix(T.slate, T.cream, 0.46), T.pitch, ATTR_BOLD);
}

function crossfadeSnapshot(s, state, reduceMotion) {
  const old = state.snapshot;
  if (!old) return;
  const valid = !reduceMotion && old.w === s.w && old.h === s.h && old.ch.length === s.ch.length;
  if (!valid) { state.snapshot = null; state.fade?.set(1, true); return; }
  const fade = clamp(state.fade?.v ?? 1, 0, 1);
  if (fade <= 0) {
    s.ch = old.ch.slice(); s.copyCh = old.copyCh.slice(); s.fg.set(old.fg); s.bg.set(old.bg); s.at.set(old.at);
    if (s.lk && old.lk) s.lk.set(old.lk); if (s.links && old.links) s.links = old.links.slice(); return;
  }
  if (fade >= 1 && state.fade?.settled) { state.snapshot = null; return; }
  if (fade < 0.5 && s.links && old.links) s.links = old.links.slice();
  for (let i = 0; i < s.ch.length; i++) {
    const ch = s.ch[i], copy = s.copyCh[i], fg = s.fg[i], bg = s.bg[i], at = s.at[i], lk = s.lk?.[i] ?? 0;
    const oldBg = old.bg[i] < 0 ? T.bg : old.bg[i]; const newBg = bg < 0 ? T.bg : bg; const mixedBg = mix(oldBg, newBg, fade);
    const useOld = fade < 0.5; const sourceFg = useOld ? old.fg[i] : fg; const sourceBg = useOld ? oldBg : newBg;
    s.ch[i] = useOld ? old.ch[i] : ch; s.copyCh[i] = useOld ? old.copyCh[i] : copy;
    s.fg[i] = mix(mixedBg, sourceFg < 0 ? sourceBg : sourceFg, useOld ? 1 - fade * 2 : (fade - 0.5) * 2);
    s.bg[i] = mixedBg; s.at[i] = useOld ? old.at[i] : at;
    if (s.lk) s.lk[i] = useOld && old.lk ? old.lk[i] : lk;
  }
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
  const selected = state.options[state.index] ?? '';
  const level = String(selected).toLowerCase();
  const cosmic = cosmicLevel(level);
  const maxed = level === 'max';
  const storm = level === 'xhigh' || maxed;
  const moving = !!state.open && !st.reduceMotion;
  const bg = storm ? T.pitch : mix(T.cream, T.bg, 0.06);
  const border = storm ? mix(T.slate, T.cream, 0.38 + pulse * 0.2) : mix(T.rule, T.accent, 0.6 + pulse * 0.18);
  panel(s, px, py, pw, ph, {
    bg,
    border,
    style: HEAVY,
    shadow: true,
    shadowOff: 2,
    shadowColor: mix(T.bg, T.pitch, storm ? 0.72 * p : 0.38 * p),
    label: state.debug ? 'EFFORT / DEBUG' : 'EFFORT / LEVEL',
    labelColor: storm ? mix(T.cream, T.bg, 0.22) : T.accent,
  });
  const interiorX = px + 1;
  const interiorY = py + 1;
  const interiorW = pw - 2;
  const footerY = py + ph - 2;
  if (level === 'xhigh') paintSky(s, interiorX, interiorY, interiorW, ph - 2, t, moving, bg, true);
  else if (maxed) {
    const oceanY = Math.min(footerY - 1, py + 6);
    paintSky(s, interiorX, interiorY, interiorW, Math.max(1, footerY - interiorY), t, moving, bg, true);
    paintOcean(s, interiorX, oceanY, interiorW, Math.max(0, footerY - oceanY), t, moving);
  }
  state.hits = [];
  state.geometry = { x: px, y: py, w: pw, h: ph };

  const cancel = ` ${MARK.cross} `;
  const cancelX = px + pw - strWidth(cancel) - 2;
  s.text(cancelX, py, cancel, T.bg, mix(bg, T.accent, 0.78), ATTR_BOLD);
  state.hits.push({ kind: 'cancel', x1: cancelX, x2: cancelX + strWidth(cancel) - 1, y1: py, y2: py });

  const current = state.options[state.currentIndex] ?? '';
  const bodyFg = storm ? mix(T.cream, T.bg, 0.2) : mix(bg, T.fg, p);
  const mutedFg = storm ? mix(T.slate, T.cream, 0.38) : mix(bg, T.dim, p);
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
    storm ? mutedFg : mix(bg, T.slate, p), bg, ATTR_BOLD);
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
      s.text(axisX, directionY, axis, mutedFg, bg, ATTR_DIM);
    }
  }

  const trackY = py + 3;
  const cursor = clamp(state.cursor?.v ?? state.index, 0, Math.max(0, state.options.length - 1));
  const cursorX = state.options.length <= 1 ? positions[0]
    : Math.round(trackX1 + ((trackX2 - trackX1) * cursor) / (state.options.length - 1));
  const cursorProgress = drawSpectrum(s, trackX1, trackX2, trackY, cursor,
    state.options.length, t, moving, !!st.reduceMotion, bg, p);
  for (const x of positions) s.put(x, trackY, LIGHT.cross, mix(bg, T.slate, 0.72), bg, ATTR_BOLD);
  const currentX = positions[state.currentIndex] ?? cursorX;
  s.put(currentX, trackY, MARK.dia_o, mix(bg, T.slate, p), bg, ATTR_BOLD);
  s.put(cursorX, trackY, MARK.diamond, mix(bg, spectrumColor(cursorProgress), 0.9 + pulse * 0.1), bg, ATTR_BOLD);

  const labelY = py + 4;
  const spacing = positions.length > 1 ? positions[1] - positions[0] : trackX2 - trackX1;
  const longest = Math.max(1, ...state.options.map((option) => strWidth(option)));
  const showAll = !compact && spacing >= longest + 2;
  if (showAll) {
    for (let i = 0; i < state.options.length; i++) {
      const option = state.options[i];
      const isSelected = i === state.index;
      const tx = clamp(positions[i] - Math.floor(strWidth(option) / 2), px + 2, px + pw - strWidth(option) - 2);
      if (isSelected && cosmicLevel(option)) drawCosmicLabel(s, tx, labelY, option, t, moving);
      else s.text(tx, labelY, option,
        isSelected ? T.bg : mix(bg, i === state.currentIndex ? T.slate : T.dim, p),
        isSelected ? mix(bg, T.accent, 0.88) : bg,
        isSelected || i === state.currentIndex ? ATTR_BOLD : ATTR_DIM);
    }
  } else {
    const label = ` ${selected} `;
    const labelX = Math.floor((s.w - strWidth(label)) / 2);
    if (cosmic) { s.fillRect(labelX, labelY, strWidth(label), 1, ' ', T.pitch, T.pitch); drawCosmicLabel(s, labelX + 1, labelY, selected, t, moving); }
    else s.text(labelX, labelY, label, T.bg, mix(bg, T.accent, 0.86), ATTR_BOLD);
  }

  const labelHitY1 = Math.max(py + 1, trackY - 1);
  for (let i = 0; i < positions.length; i++) {
    const left = i === 0 ? trackX1 - 1 : Math.floor((positions[i - 1] + positions[i]) / 2) + 1;
    const right = i === positions.length - 1 ? trackX2 + 1 : Math.floor((positions[i] + positions[i + 1]) / 2);
    state.hits.push({ kind: 'option', index: i, x1: left, x2: right, y1: labelHitY1, y2: labelY });
  }

  if (ph >= 9) {
    const desc = `${MARK.star} ${effortDescription(selected)}`;
    s.text(px + 3, py + 5, ellipsize(desc, pw - 6), bodyFg, bg, ATTR_DIM);
  }
  const hint = compact ? '← →' : '← →  PREVIEW';
  s.text(px + 3, footerY, hint, mutedFg, bg, ATTR_DIM);
  const apply = state.previewOnly ? (compact ? ' DONE ' : ` ${MARK.check} DONE `)
    : (compact ? ' APPLY ' : ` ${MARK.check} APPLY `);
  const applyX = px + pw - strWidth(apply) - 3;
  s.text(applyX, footerY, apply, T.bg, mix(bg, T.accent2, 0.9), ATTR_BOLD);
  state.hits.push({ kind: 'apply', x1: applyX, x2: applyX + strWidth(apply) - 1, y1: footerY, y2: footerY });

  if (state.open) shimmer(s, px + 1, py + ph - 1, pw - 2, moving ? t : 0, border, T.accent, 14, 6);
  crossfadeSnapshot(s, state, !!st.reduceMotion);
  return g;
}
