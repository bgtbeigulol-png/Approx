// Composer buffer primitives. The cursor is a Unicode code-point offset so CJK
// and emoji move as one keypress, and layout preserves trailing spaces verbatim.

import { strWidth } from './ansi.js';
import { clamp } from './anim.js';

const chars = (value) => [...String(value ?? '')];

export function inputLength(value) {
  return chars(value).length;
}

/** Keep direct state writes from tests/extensions compatible by homing to the end. */
export function syncComposer(st) {
  if (st._cursorInput !== st.input) {
    st.inputCursor = inputLength(st.input);
    st._cursorInput = st.input;
  } else {
    st.inputCursor = clamp(Number(st.inputCursor) || 0, 0, inputLength(st.input));
  }
  return st.inputCursor;
}

export function setComposerInput(st, value, cursor = Infinity) {
  st.input = String(value ?? '');
  st.inputCursor = clamp(Number.isFinite(cursor) ? cursor : inputLength(st.input), 0, inputLength(st.input));
  st._cursorInput = st.input;
}

export function insertComposerText(st, value) {
  syncComposer(st);
  const all = chars(st.input);
  const addition = chars(value);
  all.splice(st.inputCursor, 0, ...addition);
  setComposerInput(st, all.join(''), st.inputCursor + addition.length);
}

export function deleteComposerBackward(st) {
  syncComposer(st);
  if (st.inputCursor <= 0) return false;
  const all = chars(st.input);
  all.splice(st.inputCursor - 1, 1);
  setComposerInput(st, all.join(''), st.inputCursor - 1);
  return true;
}

export function deleteComposerForward(st) {
  syncComposer(st);
  const all = chars(st.input);
  if (st.inputCursor >= all.length) return false;
  all.splice(st.inputCursor, 1);
  setComposerInput(st, all.join(''), st.inputCursor);
  return true;
}

export function deleteComposerWord(st) {
  syncComposer(st);
  const left = chars(st.input).slice(0, st.inputCursor).join('').replace(/\s*\S+\s*$/u, '');
  const right = chars(st.input).slice(st.inputCursor).join('');
  setComposerInput(st, left + right, inputLength(left));
}

export function moveComposerCursor(st, delta) {
  syncComposer(st);
  st.inputCursor = clamp(st.inputCursor + delta, 0, inputLength(st.input));
  return st.inputCursor;
}

export function moveComposerLineEdge(st, end = false) {
  syncComposer(st);
  const all = chars(st.input);
  let cursor = st.inputCursor;
  if (end) {
    while (cursor < all.length && all[cursor] !== '\n') cursor++;
  } else {
    while (cursor > 0 && all[cursor - 1] !== '\n') cursor--;
  }
  st.inputCursor = cursor;
  return cursor;
}

/**
 * Hard-wrap an editable buffer without trimming or coalescing whitespace. Returns
 * the visual caret position alongside lines, including a fresh row at a full edge.
 */
export function layoutComposerInput(value, width, cursor = Infinity) {
  const source = chars(value);
  const w = Math.max(1, Number(width) || 1);
  const at = clamp(Number.isFinite(cursor) ? cursor : source.length, 0, source.length);
  const lines = [''];
  let row = 0;
  let col = 0;
  let caretRow = 0;
  let caretCol = 0;

  const markCaret = (index) => {
    if (index !== at) return;
    if (col >= w) {
      lines.push('');
      row++;
      col = 0;
    }
    caretRow = row;
    caretCol = col;
  };

  for (let i = 0; i < source.length; i++) {
    markCaret(i);
    const ch = source[i];
    if (ch === '\n') {
      lines.push('');
      row++;
      col = 0;
      continue;
    }
    const cw = Math.max(0, strWidth(ch));
    if (col > 0 && col + cw > w) {
      lines.push('');
      row++;
      col = 0;
    }
    lines[row] += ch;
    col += cw;
  }
  markCaret(source.length);
  return { lines, cursorRow: caretRow, cursorCol: caretCol };
}
