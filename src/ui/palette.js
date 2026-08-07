// Command palette overlay: scrim dim, spring-in panel, fuzzy filter, selection slide.

import { ATTR_BOLD, ATTR_DIM, strWidth } from '../ansi.js';
import { BLOCK, MARK, HEAVY } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { ease, clamp } from '../anim.js';
import { panel, rule, clippedPlate } from '../draw.js';
import { ellipsize } from '../wrap.js';

export const PALETTE_ROWS = 8;

/** Shared responsive geometry for drawing, keyboard paging, and mouse hits. */
export function paletteLayout(w, h, resultCount, p = 1) {
  const pw = Math.max(2, Math.min(64, w - (w >= 12 ? 4 : 0)));
  const maxRows = Math.max(1, Math.min(PALETTE_ROWS, h - 6));
  const rows = Math.min(maxRows, Math.max(1, resultCount));
  const ph = Math.min(h, rows + 4);
  const px = Math.max(0, Math.floor((w - pw) / 2));
  const restingY = clamp(Math.floor((h - ph) / 2) - 2, 0, Math.max(0, h - ph));
  const shift = Math.round((1 - ease.outBack(clamp(p, 0, 1))) * 6);
  const py = clamp(restingY + shift, 0, Math.max(0, h - ph));
  return { px, py, pw, ph, rows, resultY: py + 3, compact: pw < 16 || ph < 5 };
}

/** Subsequence fuzzy match. Returns {score, hits:Set} or null. */
export function fuzzy(needle, hay) {
  const query = String(needle ?? '');
  if (!query) return { score: 0, hits: new Set() };
  const n = [...query.toLowerCase()];
  const h = [...String(hay ?? '').toLowerCase()];
  const hits = new Set();
  let hi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < n.length; i++) {
    const c = n[i];
    let found = -1;
    for (let j = hi; j < h.length; j++) {
      if (h[j] === c) {
        found = j;
        break;
      }
    }
    if (found < 0) return null;
    hits.add(found);
    score += found === hi ? 3 + streak : 1;
    if (found === 0) score += 4;
    streak = found === hi ? streak + 1 : 0;
    hi = found + 1;
  }
  return { score: score - h.length * 0.02, hits };
}

export function filterCommands(cmds, query) {
  const out = [];
  for (const c of cmds) {
    const nameMatch = fuzzy(query, c.name);
    const match = nameMatch ?? fuzzy(query, c.desc);
    if (match) out.push({ ...c, _score: match.score, _hits: nameMatch?.hits ?? new Set() });
  }
  return out.sort((a, b) => b._score - a._score);
}

export function drawPalette(s, st, t) {
  const { w, h } = s;
  const p = clamp(st.paletteAnim.v, 0, 1);
  if (p <= 0.001) return;
  s.clearCursorAnchor();

  // scrim — dim the page behind, grain-preserving
  const k = p * 0.35;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      s.bg[i] = mix(s.bg[i] === -1 ? T.bg : s.bg[i], T.shadow, k);
      s.fg[i] = mix(s.fg[i] === -1 ? T.fg : s.fg[i], T.shadow, k * 0.8);
    }
  }

  const { px, py, pw, ph, rows, resultY, compact } = paletteLayout(w, h, st.paletteResults.length, p);

  // One-cell safety halo. A normal fillRect repairs any CJK glyph cut by the
  // boundary by painting its other half with the halo colour; that is the pale
  // one-cell "tooth" seen outside the frame. This clipped plate still clears the
  // whole glyph, but restores the outside half's scrim style after the fill.
  clippedPlate(s, px - 1, py - 1, pw + 2, ph + 2, T.fg,
    (i) => mix(s.bg[i] === -1 ? T.bg : s.bg[i], T.bg, p));

  panel(s, px, py, pw, ph, {
    bg: T.panel,
    border: T.fg,
    style: HEAVY,
    shadow: false,
  });

  if (compact) {
    const label = ellipsize(`PALETTE ${st.paletteQuery}`, Math.max(1, pw - 4));
    const labelY = py + Math.min(1, ph - 1);
    const labelW = s.text(px + 2, labelY, label, T.fg, T.panel, ATTR_BOLD, Math.max(0, pw - 4));
    s.setCursorAnchor(Math.min(px + pw - 2, px + 2 + labelW), labelY);
    return;
  }

  // title slab + result count, both padded so the heavy frame stays continuous
  s.fillRect(px + 1, py, Math.min(pw - 2, 12), 1, ' ', T.bg, T.fg);
  s.text(px + 2, py, 'PALETTE', T.bg, T.fg, ATTR_BOLD);
  const cnt = ` ${st.paletteResults.length} `;
  if (strWidth(cnt) + 14 < pw) {
    s.text(px + pw - strWidth(cnt) - 2, py, cnt, T.dim, T.panel, ATTR_DIM);
  }

  // query row
  const qy = py + 1;
  s.fillRect(px + 1, qy, pw - 2, 1, ' ', T.fg, T.inset);
  s.put(px + 2, qy, MARK.caret, T.accent, T.inset, ATTR_BOLD);
  const shownQuery = ellipsize(st.paletteQuery, Math.max(1, pw - 8));
  const shownQueryW = s.text(px + 4, qy, shownQuery, T.fg, T.inset);
  const queryCaretX = Math.min(px + pw - 3, px + 4 + shownQueryW);
  s.put(queryCaretX, qy, BLOCK.full, T.accent, T.inset);
  s.setCursorAnchor(queryCaretX, qy);

  rule(s, px + 1, py + 2, pw - 2, mix(T.inset, T.rule, 0.8), 0, T.panel);

  // results
  const view = st.paletteResults.slice(st.paletteScroll, st.paletteScroll + rows);
  for (let i = 0; i < view.length; i++) {
    const it = view[i];
    const idx = st.paletteScroll + i;
    const sel = idx === st.paletteIndex;
    const ry = resultY + i;
    // per-row stagger on open
    const rp = clamp((p * (rows + 2) - i) / 1.5, 0, 1);
    if (rp <= 0.02) continue;

    const rowBg = sel ? T.fg : T.panel;
    const rowFg = sel ? T.bg : T.fg;
    const animatedBg = mix(T.panel, rowBg, rp);
    s.fillRect(px + 1, ry, pw - 2, 1, ' ', rowFg, animatedBg);
    if (sel) {
      s.put(px + 1, ry, BLOCK.full, mix(T.panel, T.accent, rp), animatedBg);
      s.put(px + 2, ry, MARK.tri_r, mix(rowBg, T.accent, rp), rowBg, ATTR_BOLD);
    }

    // name with fuzzy hit emphasis
    const nameX = px + 4;
    const key = String(it.key ?? '');
    const keyW = strWidth(key);
    const keyEnd = px + pw - 3;
    const contentRight = keyW ? keyEnd - keyW - 1 : keyEnd;
    const twoColumns = pw >= 44 && contentRight - nameX >= 24;
    const nameW = twoColumns ? Math.min(20, Math.max(10, Math.floor((pw - 8) * 0.36))) : Math.max(1, contentRight - nameX + 1);
    let cx = nameX;
    const nm = ellipsize(it.name, nameW);
    for (const [j, glyph] of [...nm].entries()) {
      const hitCol = sel ? T.warn : T.accent;
      const baseCol = rowFg;
      const on = it._hits?.has(j);
      s.put(cx, ry, glyph, mix(T.panel, on ? hitCol : baseCol, rp), animatedBg, on ? ATTR_BOLD : 0);
      cx += strWidth(glyph);
    }
    // description
    if (twoColumns) {
      const descX = nameX + nameW + 2;
      const descW = Math.max(0, contentRight - descX + 1);
      const dcol = sel ? mix(T.fg, T.bg, 0.66) : T.dim;
      s.text(descX, ry, ellipsize(it.desc, descW), mix(T.panel, dcol, rp), animatedBg, ATTR_DIM, descW);
    }
    // key binding
    if (key) {
      s.textRight(keyEnd, ry, key, mix(T.panel, sel ? T.bg : T.rule, rp), animatedBg, ATTR_DIM);
    }
  }

  if (!st.paletteResults.length) {
    s.text(px + 4, resultY, 'no match', mix(T.panel, T.dim, p), T.panel, ATTR_DIM);
  }

  // footer hints, inset into the bottom rule with padding on both sides
  const fy = py + ph - 1;
  const foot = ' ↑↓ move   ↵ run   esc close ';
  if (strWidth(foot) + 4 < pw) {
    s.text(px + 2, fy, foot, mix(T.panel, T.dim, p), T.panel, ATTR_DIM);
  }

  // scroll pip
  if (st.paletteResults.length > rows) {
    const track = rows;
    const pos = Math.round((st.paletteIndex / (st.paletteResults.length - 1)) * (track - 1));
    for (let i = 0; i < track; i++) {
      s.put(px + pw - 2, resultY + i, i === pos ? BLOCK.full : BLOCK.l1, mix(T.panel, i === pos ? T.accent : T.rule, p));
    }
  }
}
