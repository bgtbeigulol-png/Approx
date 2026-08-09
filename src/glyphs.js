// Glyph vocabulary. Brutalist = heavy rules, blocks, hard corners.

export const BLOCK = {
  full: '█',
  l7: '▉', l6: '▊', l5: '▋', l4: '▌', l3: '▍', l2: '▎', l1: '▏',
  // vertical fills, bottom-up
  b1: '▁', b2: '▂', b3: '▃', b4: '▄', b5: '▅', b6: '▆', b7: '▇',
  top: '▀',
  shade1: '░', shade2: '▒', shade3: '▓',
  half: '▄',
};

/** Left-edge partial blocks, index 0..8 -> 0..1 of a cell. */
export const LEFT_RAMP = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
/** Bottom-up partial blocks, index 0..8. */
export const UP_RAMP = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
/** Density ramp for fades / dissolves. */
export const DENSITY = [' ', '░', '▒', '▓', '█'];

export const HEAVY = {
  h: '━', v: '┃',
  tl: '┏', tr: '┓', bl: '┗', br: '┛',
  tee_d: '┳', tee_u: '┻', tee_r: '┣', tee_l: '┫', cross: '╋',
};

export const LIGHT = {
  h: '─', v: '│',
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  tee_d: '┬', tee_u: '┴', tee_r: '├', tee_l: '┤', cross: '┼',
};

export const DOUBLE = {
  h: '═', v: '║',
  tl: '╔', tr: '╗', bl: '╚', br: '╝',
};

export const DASH = { h: '╌', v: '╎', h4: '┈', v4: '┊' };

export const MARK = {
  dot: '·', bullet: '•', ring: '◦', diamond: '◆', dia_o: '◇',
  sq: '■', sq_o: '□', tri_r: '▶', tri_l: '◀', tri_u: '▲', tri_d: '▼',
  star: '✦', cross: '✕', check: '✓', arrow: '→', arrow_l: '←',
  caret: '›', ellipsis: '…', pipe: '│', bar: '▌',
};

/** Braille spinner — 8 phases, smooth and dense. */
export const SPIN_BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];
/** Half-block orbit — chunky, reads as rotation. */
export const SPIN_BLOCK = ['▖', '▘', '▝', '▗'];
/** Growing bar — brutalist pulse. */
export const SPIN_BAR = ['▁', '▃', '▄', '▅', '▆', '▇', '▆', '▅', '▄', '▃'];
/** Corner sweep. */
export const SPIN_CORNER = ['◜', '◠', '◝', '◞', '◡', '◟'];

/**
 * 5-row stencil numerals for oversized readouts. Widths vary per glyph, so
 * callers must advance by `row[0].length` rather than a fixed pitch.
 */
export const STENCIL = {
  0: ['███', '█ █', '█ █', '█ █', '███'],
  1: ['██ ', ' █ ', ' █ ', ' █ ', '███'],
  2: ['███', '  █', '███', '█  ', '███'],
  3: ['███', '  █', '███', '  █', '███'],
  4: ['█ █', '█ █', '███', '  █', '  █'],
  5: ['███', '█  ', '███', '  █', '███'],
  6: ['███', '█  ', '███', '█ █', '███'],
  7: ['███', '  █', '  █', '  █', '  █'],
  8: ['███', '█ █', '███', '█ █', '███'],
  9: ['███', '█ █', '███', '  █', '███'],
  '.': [' ', ' ', ' ', ' ', '█'],
  ',': [' ', ' ', ' ', ' ', '█'],
  '%': ['█ █', '  █', ' █ ', '█  ', '█ █'],
  '/': ['  █', '  █', ' █ ', '█  ', '█  '],
  '-': ['   ', '   ', '███', '   ', '   '],
  ' ': ['  ', '  ', '  ', '  ', '  '],
};

/** Big 5-row digits/letters for the splash logotype. */
export const BIG = {
  A: ['█████', '█   █', '█████', '█   █', '█   █'],
  P: ['█████', '█   █', '█████', '█    ', '█    '],
  R: ['█████', '█   █', '████ ', '█  █ ', '█   █'],
  O: ['█████', '█   █', '█   █', '█   █', '█████'],
  X: ['█   █', ' █ █ ', '  █  ', ' █ █ ', '█   █'],
  ' ': ['     ', '     ', '     ', '     ', '     '],
};

/** Render a word with BIG into an array of 5 strings. */
export function bigWord(word, gap = 1) {
  const rows = ['', '', '', '', ''];
  const sp = ' '.repeat(gap);
  for (const c of word.toUpperCase()) {
    const g = BIG[c] || BIG[' '];
    for (let i = 0; i < 5; i++) rows[i] += (rows[i] ? sp : '') + g[i];
  }
  return rows;
}
