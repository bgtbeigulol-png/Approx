// Input box. Grows with content, animates focus, sub-cell caret, slash-hint chip.

import { ATTR_BOLD, ATTR_DIM, ATTR_UNDER, strWidth } from '../ansi.js';
import { BLOCK, MARK, HEAVY } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { ease, clamp, norm } from '../anim.js';
import { panel, hint, shimmer } from '../draw.js';
import { ellipsize } from '../wrap.js';
import { layoutComposerInput, syncComposer } from '../composer-state.js';
import { queueHeight } from './queue.js';
import { fileMentionSpans } from '../file-mention-highlight.js';

export const MAX_ROWS = 6;
/** Visible rows in the floating slash-command menu. */
export const SUGGESTION_ROWS = 5;
export const SLASH_ROWS = SUGGESTION_ROWS;

/** Rows the composer needs for `text` at inner width `iw`. */
export function composerRows(text, iw) {
  const n = layoutComposerInput(text || '', iw).lines.length;
  return clamp(n, 1, MAX_ROWS);
}

/** Total composer height including frame. */
export function composerHeight(text, w) {
  return composerRows(text, w - 6) + 2;
}

export function drawComposer(s, st, x, y, w, t) {
  const iw = w - 6;
  syncComposer(st);
  const inputLayout = layoutComposerInput(st.input, iw, st.inputCursor);
  const lines = inputLayout.lines;
  const rows = clamp(lines.length, 1, MAX_ROWS);
  const h = rows + 2;

  const focus = st.focusAnim.v; // 0..1
  const signal = T.accent;
  const border = mix(T.rule, signal, focus);
  const bg = mix(T.cream, signal, st.plan?.mode === 'go' ? 0.075 : 0.045);

  panel(s, x, y, w, h, {
    bg,
    border,
    style: HEAVY,
    shadow: true,
    shadowOff: 1,
    shadowColor: mix(T.bg, signal, 0.2),
    ...(st.messageEdit?.mode === 'editing' ? { label: 'EDIT USER', labelColor: T.accent } : {}),
  });

  // Keep the editor row static while an IME owns preedit. Node receives only the
  // committed text, so a time-driven pulse here would erase/recreate composition.
  s.put(x + 1, y + 1, MARK.tri_r, mix(bg, signal, focus), bg, ATTR_BOLD);

  // the text
  const start = clamp(inputLayout.cursorRow - rows + 1, 0, Math.max(0, lines.length - rows));
  for (let i = 0; i < rows; i++) {
    const ln = lines[start + i] ?? '';
    drawComposerText(s, x + 3, y + 1 + i, ln, bg, iw);
  }

  // A placeholder cannot coexist with terminal-managed preedit: the IME only
  // covers its own glyph span and leaves the rest of the placeholder attached.
  // The prompt sigil and status shortcuts already communicate input ownership.

  // Leave the anchor cell empty. The native terminal caret is visible there and
  // Windows Terminal owns the preedit glyphs drawn over it.
  const caretRow = inputLayout.cursorRow - start;
  const cy = y + 1 + clamp(caretRow, 0, rows - 1);
  const cxp = x + 3 + inputLayout.cursorCol;
  s.setCursorAnchor(Math.min(x + w - 3, cxp), cy);
  // Busy no longer locks the editor: the shimmer signals an active turn while the
  // live caret makes it clear that the next prompt can already be composed.
  if (st.busy) shimmer(s, x + 1, y + h - 1, w - 2, t, border, signal, 11, 8);

  // char counter — inset into the bottom rule, with its own padding so the
  // heavy border reads as continuous instead of gap-toothed
  if (st.input) {
    const meter = ` ${[...st.input].length} `;
    const mw = strWidth(meter);
    if (mw + 6 < w) {
      s.text(x + w - mw - 2, y + h - 1, meter, mix(bg, T.dim, 0.95), bg, ATTR_DIM);
    }
  }

  // Prompt suggestions share one compact layer above the box.
  if (composerSuggestionState(st)) {
    const lift = queueHeight(st);
    drawSuggestionMenu(s, st, x, y - lift - (lift ? 1 : 0), w);
  }

  return h;
}

function drawComposerText(s, x, y, text, bg, maxW) {
  let cx = x;
  let room = maxW;
  for (const span of fileMentionSpans(text)) {
    if (room <= 0) break;
    const marker = span.part === 'marker';
    const fg = span.mention ? (marker ? T.mentionMark : T.mentionPath) : T.fg;
    const spanBg = span.mention ? mix(bg, T.mentionMark, 0.08) : bg;
    const attrs = span.mention ? (marker ? ATTR_BOLD : ATTR_UNDER) : 0;
    const drawn = s.text(cx, y, span.text, fg, spanBg, attrs, room);
    cx += drawn;
    room -= drawn;
  }
}

/** Animated one-line confirmation card shown before a destructive branch rewind. */
export function drawRewindConfirm(s, st, x, y, w, t) {
  if (y < 1 || w < 28) return;
  const p = ease.outQuint(clamp(st.rewindAnim?.v ?? 0, 0, 1));
  const edit = st.messageEdit ?? {};
  const bg = mix(T.bg, T.cream, 0.96);
  const border = mix(T.rule, T.accent, 0.45 + p * 0.35);
  panel(s, x, y, w, 3, {
    bg,
    border,
    style: HEAVY,
    shadow: true,
    shadowOff: 1,
    shadowColor: mix(T.bg, T.accent, 0.16 * p),
    label: 'REWIND?',
    labelColor: T.accent,
  });

  const count = Number(edit.messageCount) || 0;
  const files = Number(edit.mutationCount) || 0;
  const left = `${count} messages  ·  undo ${files} Write/Edit`;
  const keys = 'Y / ↵ confirm    N / esc back';
  const room = w - 6;
  s.text(x + 3, y + 1, ellipsize(left, Math.max(8, room - strWidth(keys) - 3)), T.fg, bg, ATTR_BOLD);
  s.textRight(x + w - 3, y + 1, keys, mix(bg, T.accent, 0.82), bg, ATTR_BOLD);

  const sweep = Math.max(1, Math.round((w - 2) * p));
  for (let i = 0; i < sweep; i++) {
    const wave = 0.25 + 0.75 * Math.max(0, 1 - Math.abs(i - sweep + 5) / 7);
    s.tint(x + 1 + i, y + 2, mix(bg, T.accent, wave * 0.55));
  }
}

function composerSuggestionState(st) {
  if (st.fileMention?.context && st.fileMention.matches.length) {
    return {
      label: 'FILES', items: st.fileMention.matches,
      index: st.fileMention.index, scroll: st.fileMention.scroll,
    };
  }
  if (st.input.startsWith('/') && st.slashMatches.length) {
    return {
      label: 'COMMANDS', items: st.slashMatches,
      index: st.slashIndex, scroll: st.slashScroll,
    };
  }
  return null;
}

function drawSuggestionMenu(s, st, x, y, w) {
  const menu = composerSuggestionState(st);
  if (!menu) return;
  const n = menu.items.length;
  const rows = Math.min(SUGGESTION_ROWS, n);
  const scroll = clamp(menu.scroll, 0, Math.max(0, n - rows));
  const items = menu.items.slice(scroll, scroll + rows);
  const mh = rows + 2;
  const my = y - mh;
  if (my < 3) return;
  const mw = Math.min(w, 46);
  const longest = Math.max(...items.map((item) => strWidth(item.name)), 12);
  const nameW = clamp(longest, 12, Math.max(12, mw - 16));
  const p = ease.outCubic(clamp(st.slashAnim.v, 0, 1));
  const shown = Math.max(1, Math.round(items.length * p));

  panel(s, x, my, mw, mh, {
    bg: T.cream,
    border: mix(T.rule, T.accent, 0.5),
    label: menu.label,
    labelColor: T.slate,
    shadow: true,
  });
  // result count, padded so the top rule reads as continuous
  if (n > rows) {
    const cnt = ` ${menu.index + 1}/${n} `;
    s.text(x + mw - strWidth(cnt) - 2, my, cnt, mix(T.cream, T.dim, 1), T.cream, ATTR_DIM);
  }

  for (let i = 0; i < shown; i++) {
    const it = items[i];
    const idx = scroll + i;
    const sel = idx === menu.index;
    const ry = my + 1 + i;
    if (sel) {
      s.fillRect(x + 1, ry, mw - 2, 1, ' ', T.bg, T.accent);
      s.put(x + 1, ry, BLOCK.l4, T.bg, T.accent);
    }
    const fg = sel ? T.bg : T.fg;
    const bg2 = sel ? T.accent : T.cream;
    s.text(x + 3, ry, ellipsize(it.name, nameW), fg, bg2, ATTR_BOLD, nameW);
    const descX = x + 3 + nameW + 1;
    s.text(descX, ry, ellipsize(it.desc || '', Math.max(0, x + mw - 2 - descX)),
      sel ? mix(T.accent, T.bg, 0.75) : T.dim, bg2, ATTR_DIM);
  }

  // scroll pip on the right frame — shows there is more above/below
  if (n > rows) {
    const pos = Math.round((menu.index / (n - 1)) * (rows - 1));
    for (let i = 0; i < rows; i++) {
      const on = i === pos;
      s.put(x + mw - 1, my + 1 + i, on ? BLOCK.full : BLOCK.l1, mix(T.cream, on ? T.accent : T.sand, p));
    }
  }
}
