// Context compaction takeover. Pi exposes start/end rather than fractional
// progress, so the live bar is deliberately indeterminate and only lands at
// 100% after the runtime confirms the new context checkpoint.

import { ATTR_BOLD, ATTR_DIM, DEFAULT, strWidth } from '../ansi.js';
import { BLOCK, DENSITY, HEAVY, MARK } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { clamp, ease } from '../anim.js';
import { bar, box, ruleFade, shimmer } from '../draw.js';
import { ellipsize } from '../wrap.js';

const STAGES = ['CUT', 'DISTILL', 'RELOAD'];

export function drawCompact(s, st, t) {
  const compact = st.compact;
  if (!compact) return;
  const p = clamp(compact.enter?.v ?? 0, 0, 1);
  if (p <= 0.001) return;
  s.clearCursorAnchor();
  if (s.w < 30 || s.h < 10) return drawCompactSmall(s, st, t, p);

  const running = compact.phase === 'running';
  const failed = compact.phase === 'error' || compact.phase === 'aborted';
  const pulse = clamp(compact.pulse?.v ?? 0, 0, 1);
  const panelW = Math.min(78, s.w - 6);
  const panelH = Math.min(11, s.h - 4);
  const settledX = Math.floor((s.w - panelW) / 2);
  const slide = Math.round((1 - ease.outBack(p)) * Math.min(18, panelW / 3));
  const x = settledX + slide;
  const y = Math.floor((s.h - panelH) / 2);
  const bg = mix(T.bg, T.panel, 0.64);
  const edge = failed ? T.warn : mix(T.rule, T.accent, 0.62 + pulse * 0.28);

  scrim(s, p);

  // The two-cell offset shadow and exposed registration rail make the takeover
  // read like a physical print plate slamming over the transcript.
  s.fillRect(x + 2, y + 1, panelW, panelH, ' ', T.shadow, mix(T.bg, T.shadow, 0.72));
  s.fillRect(x, y, panelW, panelH, ' ', T.fg, bg);
  box(s, x, y, panelW, panelH, HEAVY, edge, bg);
  s.fillRect(x, y, Math.min(panelW, Math.max(8, Math.round(panelW * p))), 1, ' ', T.bg, edge);
  s.text(x + 2, y, ellipsize('CONTEXT // COMPACTION', panelW - 5), T.bg, edge, ATTR_BOLD);

  const reason = compact.reason === 'threshold' ? 'AUTO / THRESHOLD'
    : compact.reason === 'overflow' ? 'AUTO / OVERFLOW'
      : 'MANUAL / DIRECT';
  if (panelW > strWidth(reason) + 30) {
    s.textRight(x + panelW - 3, y, reason, T.bg, edge, ATTR_BOLD);
  }

  const headline = running ? 'CRUSHING CONTEXT INTO A CHECKPOINT'
    : failed ? (compact.phase === 'aborted' ? 'COMPACTION INTERRUPTED' : 'CHECKPOINT FAILED')
      : 'CONTEXT REFORGED';
  const elapsed = Math.max(0, (compact.finishedAt || t) - (compact.startedAt || t));
  const clock = `${elapsed.toFixed(1)}s`;
  const headlineW = Math.max(4, panelW - 8 - strWidth(clock));
  s.text(x + 3, y + 2, ellipsize(headline, headlineW), failed ? T.warn : T.fg, bg, ATTR_BOLD);
  s.textRight(x + panelW - 3, y + 2, clock, T.dim, bg, ATTR_DIM);
  ruleFade(s, x + 3, y + 3, panelW - 6, edge, bg, 0);

  if (panelH >= 9) drawStages(s, compact, x + 3, y + 4, panelW - 6, t, bg, running);
  drawProgress(s, compact, x + 3, y + panelH - 4, panelW - 6, t, bg, running, failed, st.reduceMotion);

  const before = Number.isFinite(compact.tokensBefore) ? formatTokens(compact.tokensBefore) : 'MEASURING';
  const after = Number.isFinite(compact.tokensAfter) ? formatTokens(compact.tokensAfter) : running ? 'CHECKPOINT' : '--';
  const telemetry = `${before}  ${MARK.arrow}  ${after}`;
  const telemetryW = Math.max(4, panelW - 6);
  s.text(x + 3, y + panelH - 2, ellipsize(telemetry, telemetryW), T.slate, bg, ATTR_BOLD);

  if (running && !st.reduceMotion) {
    shimmer(s, x + 1, y, panelW - 2, t, edge, T.fg, 18, 5);
  }
}

function drawStages(s, compact, x, y, w, t, bg, running) {
  const age = Math.max(0, t - (compact.startedAt || t));
  const active = running ? Math.floor(age * 1.35) % STAGES.length : STAGES.length - 1;
  const gap = 3;
  const cellW = Math.max(6, Math.floor((w - gap * 2) / 3));
  for (let i = 0; i < STAGES.length; i++) {
    const sx = x + i * (cellW + gap);
    const hot = i === active;
    const complete = !running || i < active;
    const mark = complete ? MARK.check : hot ? MARK.tri_r : MARK.sq_o;
    const col = hot || complete ? T.accent : T.dim;
    s.text(sx, y, `${mark} ${STAGES[i]}`, mix(bg, col, hot ? 0.95 : 0.68), bg,
      hot || complete ? ATTR_BOLD : ATTR_DIM, cellW);
    if (i < STAGES.length - 1) {
      const rx = sx + cellW;
      for (let j = 0; j < gap; j++) s.put(rx + j, y, j === 1 ? MARK.arrow : HEAVY.h, T.rule, bg);
    }
  }
}

function drawProgress(s, compact, x, y, w, t, bg, running, failed, reduceMotion) {
  if (w < 4) return;
  s.text(x, y, running ? 'COMPACT' : failed ? 'HALT' : 'SEALED', failed ? T.warn : T.dim, bg, ATTR_BOLD);
  const labelW = 9;
  const trackX = x + labelW;
  const trackW = Math.max(1, w - labelW);
  s.fillRect(trackX, y, trackW, 1, BLOCK.full, T.inset, bg);

  if (!running) {
    const amount = failed ? 0 : clamp(compact.progress?.v ?? 1, 0, 1);
    bar(s, trackX, y, trackW, amount, failed ? T.warn : T.accent, T.inset, bg);
    return;
  }

  const span = Math.max(3, Math.floor(trackW * 0.28));
  const cycle = reduceMotion ? 0.5 : (t * 0.72) % 2;
  const q = cycle <= 1 ? ease.inOutCubic(cycle) : ease.inOutCubic(2 - cycle);
  const head = Math.round(q * Math.max(0, trackW - span));
  for (let i = 0; i < span; i++) {
    const fade = 1 - Math.abs(i - (span - 1) / 2) / Math.max(1, span / 2);
    const glyph = DENSITY[Math.max(2, Math.min(4, Math.round(2 + fade * 2)))];
    // Keep the moving signal in the same vermilion family as the takeover edge.
    // Blending against the panel gives the density ramp depth without introducing
    // a competing teal hue into the progress track.
    s.put(trackX + head + i, y, glyph, mix(bg, T.accent, 0.72 + fade * 0.28), bg, ATTR_BOLD);
  }
}

function drawCompactSmall(s, st, t, p) {
  const compact = st.compact;
  const running = compact.phase === 'running';
  const h = Math.min(4, s.h);
  const y = s.h - h;
  const bg = mix(T.bg, T.panel, 0.74);
  const edge = compact.phase === 'error' ? T.warn : T.accent;
  s.fillRect(0, y, s.w, h, ' ', T.fg, bg);
  s.fillRect(0, y, Math.round(s.w * p), 1, ' ', T.bg, edge);
  s.text(1, y, ellipsize(running ? 'COMPACTING CONTEXT' : 'CONTEXT COMPACTED', s.w - 2), T.bg, edge, ATTR_BOLD);
  if (h > 2) drawProgress(s, compact, 1, y + 2, s.w - 2, t, bg, running,
    compact.phase === 'error' || compact.phase === 'aborted', st.reduceMotion);
}

function scrim(s, amount) {
  const veil = ease.outCubic(clamp(amount, 0, 1));
  const veilBg = mix(T.bg, T.shadow, 0.12);
  for (let i = 0; i < s.ch.length; i++) {
    s.fg[i] = mix(s.fg[i] === DEFAULT ? T.fg : s.fg[i], veilBg, veil);
    s.bg[i] = mix(s.bg[i] === DEFAULT ? T.bg : s.bg[i], veilBg, veil);
  }
}

function formatTokens(value) {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M TOK`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K TOK`;
  return `${tokens} TOK`;
}
