// Width-aware word wrapping that also breaks CJK runs (no spaces to break on).

import { charWidth, strWidth } from './ansi.js';

/** Split into display-width-aware lines of at most `w` columns. */
export function wrapText(str, w) {
  if (w < 2) return [String(str)];
  const lines = [];
  for (const para of String(str).split('\n')) {
    if (para === '') {
      lines.push('');
      continue;
    }
    let line = '';
    let lw = 0;
    // tokens: whitespace-delimited chunks, but wide chars stand alone so CJK breaks anywhere
    const tokens = [];
    let buf = '';
    for (const g of para) {
      const cw = charWidth(g.codePointAt(0));
      if (cw === 2) {
        if (buf) tokens.push(buf), (buf = '');
        tokens.push(g);
      } else if (g === ' ') {
        if (buf) tokens.push(buf), (buf = '');
        tokens.push(' ');
      } else {
        buf += g;
      }
    }
    if (buf) tokens.push(buf);

    for (const tk of tokens) {
      const tw = strWidth(tk);
      if (tk === ' ' && lw === 0) continue; // swallow leading space after a break
      if (lw + tw <= w) {
        line += tk;
        lw += tw;
        continue;
      }
      if (tw > w) {
        // hard-split an over-long token
        if (line) lines.push(line), (line = ''), (lw = 0);
        let part = '';
        let pw = 0;
        for (const g of tk) {
          const gw = charWidth(g.codePointAt(0)) || 1;
          if (pw + gw > w) {
            lines.push(part);
            part = '';
            pw = 0;
          }
          part += g;
          pw += gw;
        }
        line = part;
        lw = pw;
        continue;
      }
      lines.push(line.trimEnd());
      line = tk === ' ' ? '' : tk;
      lw = tk === ' ' ? 0 : tw;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Truncate to `w` columns, appending an ellipsis when clipped. */
export function ellipsize(str, w) {
  const s = String(str);
  if (strWidth(s) <= w) return s;
  let out = '';
  let cw = 0;
  for (const g of s) {
    const gw = charWidth(g.codePointAt(0)) || 1;
    if (cw + gw > w - 1) break;
    out += g;
    cw += gw;
  }
  return out + '…';
}

/** Pad to exactly `w` display columns. */
export function padTo(str, w, align = 'left') {
  const s = ellipsize(str, w);
  const gap = Math.max(0, w - strWidth(s));
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') {
    const l = Math.floor(gap / 2);
    return ' '.repeat(l) + s + ' '.repeat(gap - l);
  }
  return s + ' '.repeat(gap);
}
