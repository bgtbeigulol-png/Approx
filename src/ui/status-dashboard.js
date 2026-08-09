// /status — a brutalist specimen sheet.
//
// Full-bleed pitch masthead, folder tabs that latch onto the rule below them,
// and one hot tint per sheet so the colour alone tells you where you are. The
// oversized stencil readout is the anchor; everything else is instrument scale,
// dotted leaders, and hard offset shadows. Each block is laid out against a
// running cursor and only drawn when it fits, so narrow terminals degrade to
// plain key/value rows instead of clipping halfway through a chart.

import { ATTR_BOLD, ATTR_DIM, DEFAULT, strWidth } from '../ansi.js';
import { BLOCK, DASH, HEAVY, LIGHT, MARK, SPIN_BRAILLE, STENCIL } from '../glyphs.js';
import { T, mix, drawPaperGrain } from '../theme.js';
import { clamp, ease } from '../anim.js';
import { bar, crops, panel, shimmer, spark, textReveal, vbar, vrule } from '../draw.js';
import { ellipsize } from '../wrap.js';
import { recentUsageDays, usageDistribution, usageTotals } from '../usage-history.js';

const PAGES = [
  { label: 'OVERVIEW', tint: T.accent },
  { label: 'ACTIVITY', tint: T.teal },
  { label: 'MODELS', tint: T.plum },
  { label: 'COSTS', tint: T.amber },
];

export function drawStatusDashboard(s, st, t) {
  const p = clamp(st.status?.anim?.v ?? 0, 0, 1);
  if (p <= 0.001) return;
  const reveal = ease.outCubic(p);
  const shift = Math.round((1 - reveal) * Math.min(12, s.w));
  const page = clamp(Math.trunc(st.status.page) || 0, 0, PAGES.length - 1);
  const sheet = PAGES[page];
  st.status.hits = [];
  s.clearCursorAnchor();

  wash(s, reveal);

  const tabsY = s.h >= 12 ? 2 : 1;
  drawMasthead(s, st, shift, s.w, t, p, sheet, page, tabsY === 2);
  drawTabStrip(s, st, shift, tabsY, s.w, page);

  const y = tabsY + (s.h >= 15 ? 3 : 2);
  const h = Math.max(1, s.h - y - 2);
  const spined = s.w >= 56 && h >= 9;
  if (spined) drawSpine(s, shift, y, h, sheet, p);
  const x = shift + (spined ? 4 : 1);
  const w = Math.max(12, s.w - x - 2);
  if (spined) crops(s, x, y, w, h - 1, mix(T.bg, sheet.tint, 0.45));

  const ctx = { p, t, tint: sheet.tint, busy: !!st.busy && !st.reduceMotion };
  if (page === 0) drawOverview(s, st, x, y, w, h, ctx);
  else if (page === 1) drawActivity(s, st, x, y, w, h, ctx);
  else if (page === 2) drawModels(s, st, x, y, w, h, ctx);
  else drawCosts(s, st, x, y, w, h, ctx);

  drawFooter(s, st, s.h - 1, s.w, sheet.tint);
}

/** Flatten the transcript to bare paper so the sheet reads as one printed page. */
function wash(s, veil) {
  for (let i = 0; i < s.ch.length; i++) {
    s.ch[i] = ' ';
    s.copyCh[i] = ' ';
    s.at[i] = 0;
    s.fg[i] = T.fg;
    s.bg[i] = mix(s.bg[i] === DEFAULT ? T.bg : s.bg[i], T.bg, veil);
  }
  drawPaperGrain(s);
}

function drawMasthead(s, st, x, w, t, p, sheet, page, shadow) {
  s.fillRect(0, 0, w, 1, ' ', T.cream, T.pitch);

  const close = ` ESC ${MARK.cross} `;
  const closeX = Math.max(0, w - strWidth(close));
  const counter = `${pad2(page + 1)}/${pad2(PAGES.length)}`;
  const counterX = Math.max(0, closeX - strWidth(counter) - 2);

  const title = ' S T A T U S ';
  const titleW = Math.min(strWidth(title), Math.max(0, counterX - x));
  if (titleW > 0) {
    s.fillRect(x, 0, titleW, 1, ' ', T.bg, sheet.tint);
    textReveal(s, x, 0, title, p, T.pitch, sheet.tint, ATTR_BOLD, titleW);
  }

  // Diagonal hatch is brutalist filler, but it also gives the masthead somewhere
  // to breathe when the model name is short instead of one long dead gap.
  let hx = x + titleW + 1;
  const meta = st.effort ? `${st.model} ${MARK.diamond} ${st.effort}` : String(st.model || '');
  const spin = st.busy ? 2 : 0;
  const avail = Math.max(0, counterX - hx - 1);
  const metaW = Math.min(strWidth(meta), Math.max(0, avail - spin - 2));
  const hatchW = Math.max(0, avail - metaW - spin);
  for (let i = 0; i < hatchW; i++) {
    s.put(hx + i, 0, '╱', mix(T.pitch, T.sand, 0.3), T.pitch);
  }
  hx += hatchW;
  if (spin) {
    const frame = SPIN_BRAILLE[Math.floor(t * 12) % SPIN_BRAILLE.length];
    hx += s.text(hx, 0, `${frame} `, sheet.tint, T.pitch, ATTR_BOLD);
  }
  if (metaW > 3) s.text(hx, 0, ellipsize(meta, metaW), T.cream, T.pitch, ATTR_BOLD, metaW);

  if (counterX > x + titleW) s.text(counterX, 0, counter, mix(T.pitch, T.sand, 0.92), T.pitch, ATTR_BOLD);
  s.text(closeX, 0, close, T.pitch, T.sand, ATTR_BOLD);
  st.status.hits.push({ kind: 'close', x1: closeX, x2: w - 1, y: 0 });

  // One offset row of half-block reads as the masthead's hard shadow falling on
  // the paper. Starting a cell in keeps it an offset, not a second bar.
  if (shadow) s.fillRect(2, 1, Math.max(0, w - 2), 1, BLOCK.top, mix(T.bg, T.shadow, 0.32), T.bg);
}

function drawTabStrip(s, st, x, y, w, page) {
  const tint = PAGES[page].tint;
  let tx = x;
  let latch = null;
  for (let i = 0; i < PAGES.length; i++) {
    const item = PAGES[i];
    const active = i === page;
    const label = w >= 66 ? `${pad2(i + 1)} ${item.label}` : w >= 44 ? item.label.slice(0, 3) : pad2(i + 1);
    const text = ` ${label} `;
    const tw = strWidth(text);
    if (tx + tw > x + w - 1) break;
    s.text(tx, y, text, active ? T.bg : T.slate, active ? item.tint : mix(T.bg, T.inset, 0.6),
      active ? ATTR_BOLD : ATTR_DIM);
    st.status.hits.push({ kind: 'page', page: i, x1: tx, x2: tx + tw - 1, y });
    if (active) latch = [tx, tx + tw - 1];
    tx += tw + 1;
  }

  const dots = PAGES.map((_, i) => (i === page ? MARK.sq : MARK.sq_o)).join(' ');
  if (w - strWidth(dots) - 2 > tx) {
    s.textRight(w - 2, y, dots, mix(T.bg, tint, 0.85), DEFAULT, ATTR_BOLD);
  }

  // The active tab bleeds a half cell into the rule below, so the strip reads as
  // a folder tab latched onto the sheet rather than four loose chips.
  const ry = y + 1;
  if (ry >= s.h - 1) return;
  for (let cx = x; cx < w; cx++) {
    const on = latch && cx >= latch[0] && cx <= latch[1];
    s.put(cx, ry, on ? BLOCK.top : HEAVY.h, on ? tint : mix(T.rule, tint, 0.28));
  }
}

/** Book-spine label down the left margin — cheap depth, strong left edge. */
function drawSpine(s, x, y, h, sheet, p) {
  vrule(s, x + 2, y, h - 1, mix(T.bg, T.rule, 0.7), 0);
  const label = sheet.label;
  for (let i = 0; i < label.length && i < h - 2; i++) {
    s.put(x, y + i, label[i], mix(T.bg, sheet.tint, 0.5 + p * 0.5), DEFAULT, ATTR_BOLD);
  }
  const foot = y + label.length + 1;
  if (foot < y + h - 1) s.put(x, foot, MARK.sq, mix(T.bg, T.rule, 0.9));
}

function drawFooter(s, st, y, w, tint) {
  s.fillRect(0, y, w, 1, ' ', T.cream, T.pitch);
  s.put(0, y, BLOCK.full, tint, T.pitch);
  let x = 2;
  for (const [key, label] of [['tab', 'sheet'], ['1-4', 'jump'], ['u', 'update'], ['esc', 'back']]) {
    if (x + strWidth(key) + strWidth(label) + 5 > w - 10) break;
    x += s.text(x, y, ` ${key} `, T.pitch, mix(T.pitch, T.cream, 0.84), ATTR_BOLD);
    x += s.text(x, y, ` ${label}`, mix(T.pitch, T.cream, 0.62), T.pitch, 0) + 2;
  }
  const trail = `${MARK.diamond} ${st.cwd || ''}`;
  if (w - x - 2 > 8) {
    s.textRight(w - 2, y, ellipsize(trail, w - x - 2), mix(T.pitch, T.sand, 0.82), T.pitch, ATTR_DIM);
  }
}

function drawOverview(s, st, x, y, w, h, ctx) {
  const total = Number(st.contextWindow) || 0;
  const used = Number(st.ctxTokens) || 0;
  const ratio = total > 0 ? clamp(used / total, 0, 1) : 0;
  const totals = usageTotals(st.usageHistory);
  const conversation = st.conversationUsage ?? totals;
  const segments = mixSegments(conversation);
  const mixTotal = segments.reduce((sum, segment) => sum + segment.value, 0);

  sectionHead(s, x, y, w, 'CONTEXT WINDOW', String(st.runtime || '').toUpperCase(), ctx.tint);
  const bottom = y + h - 3;
  let cy = y + 2;

  if (w < 46 || h < 13) {
    const rows = [
      ['LOAD', total > 0 ? `${Math.round(ratio * 100)}%` : '--', ctx.tint],
      ['CONTEXT', `${formatTokens(used)} / ${formatTokens(total)}`, T.slate],
      ['LIFETIME', `${formatTokens(totalTokens(totals))} tok`, T.teal],
      ['SPEND', formatCost(totals.cost), T.plum],
      ['CACHE HIT', percent(conversation.cacheRead, mixTotal), T.ok],
    ];
    for (const [label, value, color] of rows) {
      if (cy > bottom) break;
      leader(s, x, cy++, w, label, value, color);
    }
    return drawOverviewFoot(s, st, x, bottom, w, ctx);
  }

  // The oversized percentage is the one thing you should be able to read from
  // across the room; everything to its right is caption scale by comparison.
  const readout = total > 0 ? `${Math.round(ratio * 100)}%` : '--';
  const stencilW = stencil(s, x, cy, readout, ctx.tint, mix(T.bg, T.shadow, 0.26));
  const rx = x + stencilW + 3;
  const rw = Math.max(6, w - (rx - x));
  s.text(rx, cy, 'CONTEXT LOAD', T.dim, DEFAULT, ATTR_DIM, rw);
  s.text(rx, cy + 1, ellipsize(`${formatTokens(used)} / ${formatTokens(total)} TOK`, rw),
    ctx.tint, DEFAULT, ATTR_BOLD, rw);
  s.text(rx, cy + 3, ellipsize(`HEADROOM ${formatTokens(Math.max(0, total - used))}`, rw),
    T.slate, DEFAULT, ATTR_BOLD, rw);
  s.text(rx, cy + 4, ellipsize(compactHint(st), rw), T.dim, DEFAULT, ATTR_DIM, rw);
  cy += 6;

  if (cy + 1 <= bottom) {
    drawGauge(s, x, cy, w, ratio, ctx, compactRatio(st, total));
    cy += 3;
  }

  if (cy + 3 <= bottom && w >= 52) {
    const gap = 2;
    const plateW = Math.floor((w - gap * 2) / 3);
    const plates = [
      ['LIFETIME', `${formatTokens(totalTokens(totals))}`, 'TOKENS', T.teal],
      ['EST. SPEND', formatCost(totals.cost), 'USD', T.plum],
      ['CACHE HIT', percent(conversation.cacheRead, mixTotal), 'OF SESSION', T.ok],
    ];
    for (let i = 0; i < plates.length; i++) {
      drawPlate(s, x + i * (plateW + gap), cy, plateW, plates[i]);
    }
    cy += 5;
  }

  if (cy + 2 <= bottom) {
    s.text(x, cy, 'SESSION TOKEN MIX', T.dim, DEFAULT, ATTR_DIM, w);
    s.textRight(x + w - 1, cy, `${formatTokens(mixTotal)} TOK`, T.slate, DEFAULT, ATTR_BOLD);
    stackBand(s, x, cy + 1, w, segments, mixTotal, ctx);
    legend(s, x, cy + 2, w, segments, mixTotal);
    cy += 4;
  }

  // Live throughput closes the sheet: it is the only block here that moves while
  // a request is in flight, which keeps the page feeling attached to the runtime.
  if (cy + 1 <= bottom - 3) {
    const samples = Array.isArray(st.tps) ? st.tps : [];
    const peak = Math.max(1, ...samples);
    s.text(x, cy, 'THROUGHPUT', T.dim, DEFAULT, ATTR_DIM);
    const sparkX = x + 12;
    const sparkW = Math.max(0, Math.min(samples.length, w - 24));
    if (sparkW > 0) {
      spark(s, sparkX, cy, samples.slice(-sparkW).map((value) => num(value) / peak),
        mix(T.inset, ctx.tint, st.busy ? 0.95 : 0.55));
    }
    s.textRight(x + w - 1, cy, `${Math.round(num(st.tpsNow))} tok/s  peak ${Math.round(peak)}`,
      st.busy ? ctx.tint : T.slate, DEFAULT, ATTR_BOLD);
  }

  if (bottom - 2 > cy + 1) {
    colophon(s, x, bottom - 2, w, ctx.tint, `SHEET 01 ${MARK.diamond} OVERVIEW`,
      total > 0 ? `${formatTokens(Math.max(0, total - used))} tok of headroom` : 'no window reported');
  }
  drawOverviewFoot(s, st, x, bottom, w, ctx);
}

function drawOverviewFoot(s, st, x, y, w, ctx) {
  const update = st.update?.info;
  const checking = !!st.update?.checking;
  const installing = !!st.update?.updating;
  const ready = !!update?.available;
  const current = update && !ready && !update.reason && !update.updated;
  const failed = !!update?.reason && update.reason !== 'up-to-date';
  const label = installing ? 'INSTALLING LATEST UPDATE'
    : checking ? 'CHECKING FOR UPDATES'
      : failed
        ? (update.reason === 'check-failed' || update.reason === 'no-dist-tags'
          ? 'UPDATE CHECK FAILED' : 'UPDATE STOPPED')
    : ready ? `${String(update.channel || 'UPDATE').toUpperCase()} ${String(update.version || update.remote?.slice(0, 7) || 'READY').toUpperCase()}`
      : update?.updated ? 'UPDATED - RESTART APPROX'
        : current ? `${String(update.channel || 'UPDATE').toUpperCase()} ${String(update.currentVersion || update.version || 'CURRENT').toUpperCase()} CURRENT`
          : 'CHECK FOR UPDATES';
  const active = installing || checking || failed || ready || current || update?.updated;
  const capBg = failed ? T.warn : ready ? T.warn : installing || checking ? ctx.tint
    : current || update?.updated ? T.ok : mix(T.bg, T.inset, 0.62);
  const textColor = failed || ready ? T.warn : installing || checking ? ctx.tint
    : current || update?.updated ? T.ok : T.slate;
  let bx = x;
  bx += s.text(bx, y, ' U ', active ? T.bg : T.slate, capBg, ATTR_BOLD);
  bx += s.text(bx, y, ` ${ellipsize(label, Math.max(4, w - 8))}`,
    textColor, DEFAULT, active ? ATTR_BOLD : 0);
  if ((checking || installing) && !st.reduceMotion) shimmer(s, x, y, bx - x, ctx.t, T.slate, ctx.tint, 14, 4);
  st.status.hits.push({ kind: 'update', x1: x, x2: Math.max(x, bx - 1), y });

  s.text(x, y + 1, ellipsize(
    `turns ${st.turns}  messages ${st.msgs.length}  frames ${st.frames}  dirty ${Math.round(st.dirtyAvg || 0)}`,
    w), T.dim, DEFAULT, ATTR_DIM, w);
  s.text(x, y + 2, ellipsize(
    `uptime ${Math.round((st.age || 0) / 1000)}s  terminal ${s.w}x${s.h}  markdown ${st.markdown ? 'on' : 'off'}`,
    w), T.dim, DEFAULT, ATTR_DIM, w);
}

function drawActivity(s, st, x, y, w, h, ctx) {
  const window = 28;
  const days = recentUsageDays(st.usageHistory, window);
  const pitch = w >= 78 ? 3 : w >= 58 ? 2 : 1;
  const count = clamp(Math.floor((w - 10) / pitch), 7, window);
  const shown = days.slice(-count);
  const values = shown.map(totalTokens);
  const max = Math.max(1, ...values);
  const totals = usageTotals(st.usageHistory, { since: shown[0]?.day });

  sectionHead(s, x, y, w, 'TOKEN ACTIVITY', `${count} DAYS`, ctx.tint);
  const foot = y + h - 2;
  const bottom = foot - 2;
  let cy = y + 2;

  // Column chart with a staggered grow-in. Reading the shape matters more than
  // exact values, so only the peak carries a number.
  const chartH = clamp(bottom - cy - 7, 3, 9);
  if (chartH >= 3) {
    const peak = values.indexOf(max);
    const scaleW = 5;
    const plotX = x + scaleW;
    for (let row = 0; row < chartH; row++) {
      const level = 1 - row / Math.max(1, chartH - 1);
      s.textRight(x + scaleW - 2, cy + row, formatTokens(max * level), mix(T.bg, T.dim, 0.85),
        DEFAULT, ATTR_DIM);
      s.put(plotX - 1, cy + row, LIGHT.v, mix(T.bg, T.rule, 0.8));
    }
    for (let i = 0; i < shown.length; i++) {
      const cx = plotX + i * pitch;
      if (cx >= x + w) break;
      const grow = ease.outCubic(clamp(ctx.p * 1.5 - (i / Math.max(1, shown.length)) * 0.45, 0, 1));
      const ratio = (values[i] / max) * grow;
      const hot = i === peak && values[i] > 0;
      const color = values[i] <= 0 ? mix(T.bg, T.rule, 0.7)
        : hot ? ctx.tint : mix(T.inset, ctx.tint, 0.3 + (values[i] / max) * 0.55);
      for (let dx = 0; dx < Math.max(1, pitch - 1); dx++) {
        if (values[i] <= 0) s.put(cx + dx, cy + chartH - 1, BLOCK.b1, color);
        else vbar(s, cx + dx, cy + chartH - 1, chartH, ratio, color);
      }
      if (hot && pitch > 1) {
        const cap = cy + chartH - 1 - Math.floor(ratio * chartH);
        if (cap >= cy) s.put(cx, cap, MARK.tri_u, ctx.tint, DEFAULT, ATTR_BOLD);
      }
    }
    // baseline with a tick every seven days so weeks stay countable
    for (let i = 0; i < shown.length * pitch && plotX + i < x + w; i++) {
      const week = i % (pitch * 7) === 0;
      s.put(plotX + i, cy + chartH, week ? HEAVY.tee_u : HEAVY.h,
        mix(T.rule, ctx.tint, week ? 0.5 : 0.16));
    }
    s.put(plotX - 1, cy + chartH, HEAVY.bl, mix(T.rule, ctx.tint, 0.5));
    if (values[peak] > 0) {
      s.text(x, cy + chartH + 1,
        ellipsize(`PEAK ${shown[peak].day} ${MARK.arrow} ${formatTokens(max)} TOK`, w),
        ctx.tint, DEFAULT, ATTR_BOLD, w);
    }
    cy += chartH + 3;
  }

  // Heat strip: same data at a glance, plus the quiet/active ramp as its legend.
  if (cy + 1 <= bottom) {
    s.text(x, cy, 'HEAT', T.dim, DEFAULT, ATTR_DIM);
    const stripX = x + 5;
    const stripW = Math.max(0, Math.min(shown.length, x + w - stripX - 16));
    for (let i = 0; i < stripW; i++) {
      const value = values[values.length - stripW + i] ?? 0;
      const intensity = clamp(value / max, 0, 1);
      s.put(stripX + i, cy, intensity <= 0 ? DASH.h : intensity > 0.66 ? BLOCK.full
        : intensity > 0.33 ? BLOCK.shade3 : BLOCK.shade2,
        intensity <= 0 ? mix(T.bg, T.rule, 0.75) : mix(T.inset, ctx.tint, 0.2 + intensity * 0.8));
    }
    const rampX = x + w - 14;
    if (rampX > stripX + stripW + 1) {
      s.text(rampX - 6, cy, 'quiet', T.dim, DEFAULT, ATTR_DIM);
      for (let i = 0; i < 6; i++) s.put(rampX + i, cy, BLOCK.full, mix(T.inset, ctx.tint, i / 5));
      s.text(rampX + 7, cy, 'busy', T.dim, DEFAULT, ATTR_DIM);
    }
    cy += 2;
  }

  const active = values.filter((value) => value > 0).length;
  const rows = [
    ['WINDOW TOTAL', `${formatTokens(totalTokens(totals))} tok`, ctx.tint],
    ['WINDOW SPEND', formatCost(totals.cost), T.plum],
    ['ACTIVE DAYS', `${active} / ${shown.length}`, T.ok],
    ['DAILY AVERAGE', `${formatTokens(totalTokens(totals) / Math.max(1, active))} tok`, T.slate],
  ];
  for (const [label, value, color] of rows) {
    if (cy > bottom) break;
    leader(s, x, cy++, w, label, value, color);
  }

  const busiest = shown[values.indexOf(max)];
  colophon(s, x, Math.max(cy + 1, foot), w, ctx.tint, `SHEET 02 ${MARK.diamond} ACTIVITY`,
    max > 0 ? `busiest ${busiest.day}` : 'nothing recorded yet');
}

function drawModels(s, st, x, y, w, h, ctx) {
  const models = usageDistribution(st.usageHistory, 'models');
  const efforts = usageDistribution(st.usageHistory, 'efforts');
  sectionHead(s, x, y, w, 'MODEL MIX', 'ALL TIME', ctx.tint);
  const foot = y + h - 2;
  const bottom = foot - 2;
  let cy = y + 2;

  // Lead with the dominant model as a hero row; the rest is a ranked table.
  const lead = models[0];
  const modelTotal = models.reduce((sum, item) => sum + item.value, 0);
  if (lead && h >= 10) {
    s.text(x, cy, 'PRIMARY', T.dim, DEFAULT, ATTR_DIM);
    s.textRight(x + w - 1, cy, `${percent(lead.value, modelTotal)} OF ALL TOKENS`,
      ctx.tint, DEFAULT, ATTR_BOLD);
    s.text(x, cy + 1, ellipsize(lead.name.toUpperCase(), w), T.fg, DEFAULT, ATTR_BOLD, w);
    bar(s, x, cy + 2, w, (lead.value / Math.max(1, modelTotal)) * ease.outCubic(ctx.p),
      ctx.tint, mix(T.bg, T.inset, 0.7));
    cy += 4;
  }

  const room = Math.max(2, bottom - cy);
  const split = w >= 72 && models.length + efforts.length > 3;
  if (split) {
    // Equal column widths on purpose: an even split keeps both lists on the same
    // bar scale, so a share on the left is directly comparable to one on the right.
    const gap = 3;
    const colW = Math.floor((w - gap) / 2);
    const listH = Math.min(room, Math.max(2, Math.max(models.length, efforts.length) + 1));
    drawRankList(s, x, cy, colW, listH, 'BY MODEL', models, ctx.tint, ctx);
    vrule(s, x + colW + 1, cy, listH, mix(T.bg, T.rule, 0.75), 0);
    drawRankList(s, x + colW + gap, cy, colW, listH, 'BY EFFORT', efforts, T.teal, ctx);
    cy += listH + 1;
  } else {
    const half = Math.min(Math.max(2, Math.floor((room - 1) / 2)), models.length + 1);
    const rest = Math.min(Math.max(2, room - half - 1), efforts.length + 1);
    drawRankList(s, x, cy, w, half, 'BY MODEL', models, ctx.tint, ctx);
    drawRankList(s, x, cy + half + 1, w, rest, 'BY EFFORT', efforts, T.teal, ctx);
    cy += half + rest + 2;
  }

  // The lists rank; the bands show proportion. Same numbers, but a share you can
  // see the size of rather than read off a column.
  cy = drawSplitBand(s, x, cy, w, bottom, 'MODEL SPLIT', models, ctx, ctx.tint);
  cy = drawSplitBand(s, x, cy, w, bottom, 'EFFORT SPLIT', efforts, ctx, T.teal);

  const note = `${models.length} models ${MARK.diamond} ${efforts.length} effort levels`;
  colophon(s, x, Math.max(cy, foot), w, ctx.tint, `SHEET 03 ${MARK.diamond} MODELS`, note);
}

/** One labelled proportion band plus its legend, skipped when the rows run out. */
function drawSplitBand(s, x, y, w, bottom, label, items, ctx, tint) {
  if (!items.length || y + 2 > bottom) return y;
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return y;
  const segments = items.slice(0, 6).map((item, i) => ({
    name: String(item.name ?? item.key ?? '?').replace(/^claude-/, '').toUpperCase(),
    value: item.value,
    color: mix(tint, i % 2 ? T.sand : T.pitch, 0.12 + i * 0.15),
  }));
  s.text(x, y, label, T.dim, DEFAULT, ATTR_DIM, w);
  s.textRight(x + w - 1, y, `${formatTokens(total)} TOK`, T.slate, DEFAULT, ATTR_BOLD);
  stackBand(s, x, y + 1, w, segments, total, ctx);
  legend(s, x, y + 2, w, segments, total);
  return y + 4;
}

function drawRankList(s, x, y, w, h, title, items, color, ctx) {
  if (h < 2 || w < 12) return;
  s.text(x, y, title, T.dim, DEFAULT, ATTR_DIM, w);
  const rule = x + strWidth(title) + 1;
  for (let i = rule; i < x + w; i++) s.put(i, y, DASH.h4, mix(T.bg, T.rule, 0.8));
  if (!items.length) {
    s.text(x, y + 1, 'no usage recorded yet', mix(T.bg, T.dim, 0.9), DEFAULT, ATTR_DIM, w);
    return;
  }
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const rows = items.slice(0, h - 1);
  const barW = w >= 40 ? Math.max(6, Math.floor(w * 0.28)) : 0;
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i];
    const ry = y + 1 + i;
    const share = item.value / Math.max(1, total);
    const tail = `${percent(item.value, total)}`.padStart(4);
    let cx = x;
    cx += s.text(cx, ry, pad2(i + 1), i === 0 ? color : mix(T.bg, T.dim, 0.9), DEFAULT, ATTR_BOLD) + 1;
    const nameW = Math.max(4, w - (cx - x) - barW - strWidth(tail) - 3);
    cx += s.text(cx, ry, ellipsize(item.name, nameW), i === 0 ? T.fg : T.slate, DEFAULT,
      i === 0 ? ATTR_BOLD : 0, nameW);
    for (let dot = cx; dot < x + w - barW - strWidth(tail) - 2; dot++) {
      s.put(dot, ry, MARK.dot, mix(T.bg, T.rule, 0.85));
    }
    if (barW) {
      bar(s, x + w - barW - strWidth(tail) - 1, ry, barW, share * ease.outCubic(ctx.p),
        mix(T.inset, color, 0.35 + share * 0.65), mix(T.bg, T.inset, 0.62));
    }
    s.textRight(x + w - 1, ry, tail, i === 0 ? color : T.slate, DEFAULT, ATTR_BOLD);
  }
}

function drawCosts(s, st, x, y, w, h, ctx) {
  const totals = usageTotals(st.usageHistory);
  const conversation = st.conversationUsage ?? totals;
  const tokens = totalTokens(totals);
  sectionHead(s, x, y, w, 'TOKEN LEDGER', 'ALL TIME', ctx.tint);
  const foot = y + h - 2;
  const bottom = foot - 2;
  let cy = y + 2;

  if (w >= 52 && h >= 13) {
    const money = heroMoney(totals.cost);
    const numberW = stencil(s, x + 2, cy, money, ctx.tint, mix(T.bg, T.shadow, 0.26));
    s.put(x, cy + 2, '$', ctx.tint, DEFAULT, ATTR_BOLD);
    const rx = x + numberW + 6;
    const rw = Math.max(6, w - (rx - x));
    s.text(rx, cy, 'ESTIMATED SPEND', T.dim, DEFAULT, ATTR_DIM, rw);
    s.text(rx, cy + 1, ellipsize(`${formatTokens(tokens)} TOKENS BILLED`, rw), T.slate, DEFAULT, ATTR_BOLD, rw);
    s.text(rx, cy + 3, ellipsize(`${formatCost(costPerMillion(totals.cost, tokens))} / MTOK`, rw),
      T.plum, DEFAULT, ATTR_BOLD, rw);
    s.text(rx, cy + 4, ellipsize(`session ${formatCost(conversation.cost)}`, rw), T.dim, DEFAULT, ATTR_DIM, rw);
    // 14-day cost trend, small on purpose: the shape is the point, not the values
    const trend = recentUsageDays(st.usageHistory, 14).map((day) => day.cost);
    const peak = Math.max(...trend, 0.000001);
    if (rw >= 20) {
      s.text(rx, cy + 5, '14D', T.dim, DEFAULT, ATTR_DIM);
      spark(s, rx + 4, cy + 5, trend.map((value) => value / peak), mix(T.inset, ctx.tint, 0.8));
    }
    cy += 7;
  }

  const rows = [
    ['INPUT', totals.input, T.teal],
    ['OUTPUT', totals.output, T.accent],
    ['CACHE READ', totals.cacheRead, T.plum],
    ['CACHE WRITE', totals.cacheWrite, T.warn],
  ];
  const max = Math.max(1, ...rows.map((row) => row[1]));
  const labelW = 12;
  const valueW = 13;
  for (const [label, value, color] of rows) {
    if (cy > bottom - 1) break;
    s.text(x, cy, label, T.slate, DEFAULT, ATTR_BOLD, labelW);
    const trackX = x + labelW + 1;
    const trackW = Math.max(4, w - labelW - valueW - 3);
    bar(s, trackX, cy, trackW, (value / max) * ease.outCubic(ctx.p), color, mix(T.bg, T.inset, 0.62));
    s.textRight(x + w - 1, cy, `${formatTokens(value)}  ${percent(value, tokens).padStart(4)}`,
      color, DEFAULT, ATTR_BOLD);
    cy += 1;
  }

  // Inverted slab as the ledger's bottom line — the sheet's only solid dark row.
  const slabY = Math.min(bottom, cy + 1);
  s.fillRect(x, slabY, w, 1, ' ', T.cream, T.pitch);
  s.put(x, slabY, BLOCK.full, ctx.tint, T.pitch);
  s.text(x + 2, slabY, ellipsize('TOTAL', Math.max(1, w - 4)), T.cream, T.pitch, ATTR_BOLD);
  s.textRight(x + w - 2, slabY, `${formatTokens(tokens)} TOK  ${formatCost(totals.cost)}`,
    mix(T.pitch, ctx.tint, 0.95), T.pitch, ATTR_BOLD);
  cy = slabY + 2;

  // Lifetime is the headline above; this pairs it with what the open session has
  // spent, which is the number you act on when deciding whether to compact.
  const sessionTokens = totalTokens(conversation);
  const footRows = [
    ['THIS SESSION', `${formatTokens(sessionTokens)} tok  ${formatCost(conversation.cost)}`, ctx.tint],
    ['ALL SESSIONS', `${formatTokens(tokens)} tok  ${formatCost(totals.cost)}`, T.slate],
    ['SESSION SHARE', percent(sessionTokens, tokens), T.teal],
    ['CACHE READS', `${percent(totals.cacheRead, tokens)} of all tokens`, T.ok],
  ];
  for (const [label, value, color] of footRows) {
    if (cy > bottom) break;
    leader(s, x, cy++, w, label, value, color);
  }

  colophon(s, x, Math.max(cy + 1, foot), w, ctx.tint, `SHEET 04 ${MARK.diamond} COSTS`,
    `cache saves ${percent(totals.cacheRead, tokens)} of reads`);
}

// ---- shared primitives ----

function sectionHead(s, x, y, w, title, tag, tint) {
  let cx = x + s.text(x, y, title, T.fg, DEFAULT, ATTR_BOLD, w) + 1;
  const tagW = tag ? strWidth(tag) + 2 : 0;
  for (; cx < x + w - tagW - 1; cx++) s.put(cx, y, HEAVY.h, mix(T.bg, T.rule, 0.85));
  if (tag && tagW + 4 < w) s.textRight(x + w - 1, y, ` ${tag} `, T.bg, mix(T.slate, tint, 0.4), ATTR_BOLD);
}

/**
 * Colophon at the foot of the sheet. Pages hold their data at the top, so this
 * anchors the bottom edge and keeps a short sheet from reading as half-empty.
 */
function colophon(s, x, y, w, tint, label, note) {
  if (y + 1 >= s.h - 1) return;
  for (let i = 0; i < w; i++) s.put(x + i, y, HEAVY.h, mix(T.rule, tint, 0.32));
  s.put(x, y, HEAVY.tee_r, mix(T.rule, tint, 0.7));
  s.put(x + w - 1, y, HEAVY.tee_l, mix(T.rule, tint, 0.7));
  const used = s.text(x, y + 1, ellipsize(label, w), mix(T.bg, tint, 0.95), DEFAULT, ATTR_BOLD, w);
  const room = Math.max(0, w - used - 2);
  if (note && room > 6) s.textRight(x + w - 1, y + 1, ellipsize(note, room), T.dim, DEFAULT, ATTR_DIM);
}

/** Label + dotted leader + value: a table row that needs no borders. */
function leader(s, x, y, w, label, value, color) {
  const cx = x + s.text(x, y, label, T.slate, DEFAULT, ATTR_BOLD, Math.max(4, w - 10));
  const end = x + w - strWidth(String(value)) - 1;
  for (let dot = cx + 1; dot < end; dot++) s.put(dot, y, MARK.dot, mix(T.bg, T.rule, 0.85));
  s.textRight(x + w - 1, y, String(value), color, DEFAULT, ATTR_BOLD);
}

/** Raised metric card: hard offset shadow, label notched into the top border. */
function drawPlate(s, x, y, w, [label, value, unit, color]) {
  if (w < 11) return;
  const bg = mix(T.bg, T.panel, 0.62);
  panel(s, x, y, w, 4, {
    bg, border: mix(T.rule, color, 0.55), shadowOff: 1, label: ellipsize(label, w - 6),
    labelColor: mix(bg, color, 0.92), labelBg: bg,
  });
  s.text(x + 2, y + 1, ellipsize(value, w - 4), color, bg, ATTR_BOLD, w - 4);
  s.text(x + 2, y + 2, ellipsize(unit, w - 5), T.dim, bg, ATTR_DIM, w - 5);
  s.put(x + w - 3, y + 2, MARK.sq, mix(bg, color, 0.55), bg);
}

/** Load bar over an instrument scale, with the auto-compact trip point marked. */
function drawGauge(s, x, y, w, ratio, ctx, threshold) {
  const amount = clamp(ratio, 0, 1) * ease.outCubic(ctx.p);
  bar(s, x, y, w, amount, ctx.tint, mix(T.bg, T.inset, 0.66));
  const head = clamp(Math.round(amount * w) - 1, 0, w - 1);
  if (amount > 0.001) s.put(x + head, y, BLOCK.full, mix(ctx.tint, T.fg, 0.42));

  const tag = threshold > 0 ? `AUTO ${Math.round(threshold * 100)}%` : '';
  const scaleW = Math.max(4, w - (tag ? strWidth(tag) + 2 : 0));
  for (let i = 0; i < scaleW; i++) {
    const major = i % 10 === 0;
    s.put(x + i, y + 1, major ? MARK.pipe : i % 5 === 0 ? MARK.dot : ' ',
      mix(T.bg, T.rule, major ? 1 : 0.72));
  }
  if (tag) {
    const tx = x + Math.round(clamp(threshold, 0, 1) * (scaleW - 1));
    s.put(tx, y + 1, MARK.tri_u, T.warn, DEFAULT, ATTR_BOLD);
    s.textRight(x + w - 1, y + 1, tag, mix(T.bg, T.warn, 0.9), DEFAULT, ATTR_BOLD);
  }
}

function stackBand(s, x, y, w, segments, total, ctx) {
  const scale = ease.outCubic(ctx.p);
  let cx = x;
  for (const segment of segments) {
    const cells = Math.round((segment.value / Math.max(1, total)) * w * scale);
    for (let i = 0; i < cells && cx < x + w; i++, cx++) s.put(cx, y, BLOCK.full, segment.color);
  }
  for (; cx < x + w; cx++) s.put(cx, y, BLOCK.shade1, mix(T.bg, T.inset, 0.85));
}

function legend(s, x, y, w, segments, total) {
  let cx = x;
  for (const segment of segments) {
    const text = `${segment.name} ${percent(segment.value, total)}`;
    if (cx + strWidth(text) + 4 > x + w) break;
    s.put(cx, y, MARK.sq, segment.color);
    cx += 2 + s.text(cx + 2, y, text, T.dim, DEFAULT, ATTR_DIM) + 2;
  }
}

function mixSegments(usage) {
  return [
    { name: 'OUT', value: num(usage?.output), color: T.accent },
    { name: 'IN', value: num(usage?.input), color: T.teal },
    { name: 'CACHE R', value: num(usage?.cacheRead), color: T.plum },
    { name: 'CACHE W', value: num(usage?.cacheWrite), color: T.warn },
  ];
}

/** Oversized stencil numerals with a one-cell offset shadow. Returns width. */
function stencil(s, x, y, text, fg, shadowColor) {
  const glyphs = [...String(text)].map((ch) => STENCIL[ch] ?? STENCIL[' ']);
  for (const pass of [0, 1]) {
    let cx = x;
    for (const glyph of glyphs) {
      for (let row = 0; row < glyph.length; row++) {
        for (let col = 0; col < glyph[row].length; col++) {
          if (glyph[row][col] !== '█') continue;
          if (pass === 0) {
            if (shadowColor != null) s.put(cx + col + 1, y + row + 1, BLOCK.full, shadowColor);
          } else {
            s.put(cx + col, y + row, BLOCK.full, fg);
          }
        }
      }
      cx += glyph[0].length + 1;
    }
  }
  return Math.max(0, glyphs.reduce((sum, glyph) => sum + glyph[0].length + 1, 0) - 1);
}

function compactHint(st) {
  return st.autoCompactMode === 'tokens'
    ? `auto compact at ${formatTokens(st.autoCompactTokens)} tok`
    : `auto compact at ${Number(st.autoCompactPercent) || 0}%`;
}

function compactRatio(st, total) {
  if (st.autoCompactMode === 'tokens') {
    return total > 0 ? clamp(num(st.autoCompactTokens) / total, 0, 1) : 0;
  }
  return clamp((Number(st.autoCompactPercent) || 0) / 100, 0, 1);
}

function totalTokens(value) {
  return num(value?.input) + num(value?.output) + num(value?.cacheRead) + num(value?.cacheWrite);
}

function costPerMillion(cost, tokens) {
  return tokens > 0 ? (num(cost) / tokens) * 1_000_000 : 0;
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function pad2(value) {
  return String(Math.trunc(Number(value) || 0)).padStart(2, '0');
}

function formatTokens(value) {
  const number = num(value);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${Math.round(number / 1_000)}K`;
  return String(Math.round(number));
}

function formatCost(value) {
  const number = num(value);
  return `$${number.toFixed(number >= 1 ? 2 : 4)}`;
}

/** Stencil-sized money: trimmed to as few numerals as still carry the value. */
function heroMoney(value) {
  const number = num(value);
  if (number <= 0) return '0';
  if (number >= 100) return String(Math.round(number));
  const fixed = number.toFixed(number >= 1 ? 2 : 3);
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

function percent(value, total) {
  return `${Math.round((num(value) / Math.max(1, num(total))) * 100)}%`;
}
