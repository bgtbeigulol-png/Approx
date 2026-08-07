// Raw ANSI/SGR primitives. No dependencies, 24-bit color only.

export const ESC = '\x1b';
export const CSI = `${ESC}[`;

export const DEFAULT = -1;

/** Pack an #rrggbb / [r,g,b] / 0xrrggbb value into a single int. */
export function rgb(v) {
  if (v == null) return DEFAULT;
  if (typeof v === 'number') return v & 0xffffff;
  if (Array.isArray(v)) return ((v[0] & 255) << 16) | ((v[1] & 255) << 8) | (v[2] & 255);
  const s = v[0] === '#' ? v.slice(1) : v;
  return parseInt(s.length === 3 ? s.replace(/./g, (c) => c + c) : s, 16) & 0xffffff;
}

export const r_ = (c) => (c >> 16) & 255;
export const g_ = (c) => (c >> 8) & 255;
export const b_ = (c) => c & 255;

/** Linear blend of two packed colors. t=0 -> a, t=1 -> b. */
export function mix(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const ir = 1 - k;
  return (
    ((Math.round(r_(a) * ir + r_(b) * k) & 255) << 16) |
    ((Math.round(g_(a) * ir + g_(b) * k) & 255) << 8) |
    (Math.round(b_(a) * ir + b_(b) * k) & 255)
  );
}

/** Multiply lightness. f<1 darkens, f>1 lightens toward white. */
export function shade(c, f) {
  if (f <= 1) return mix(0x000000, c, f);
  return mix(c, 0xffffff, f - 1);
}

export const ATTR_BOLD = 1;
export const ATTR_DIM = 2;
export const ATTR_ITALIC = 4;
export const ATTR_UNDER = 8;
export const ATTR_REV = 16;

/** Build the SGR sequence that moves from `prev` state to the given state. */
export function sgr(fg, bg, attr) {
  const p = ['0'];
  if (attr & ATTR_BOLD) p.push('1');
  if (attr & ATTR_DIM) p.push('2');
  if (attr & ATTR_ITALIC) p.push('3');
  if (attr & ATTR_UNDER) p.push('4');
  if (attr & ATTR_REV) p.push('7');
  if (fg !== DEFAULT) p.push('38', '2', String(r_(fg)), String(g_(fg)), String(b_(fg)));
  if (bg !== DEFAULT) p.push('48', '2', String(r_(bg)), String(g_(bg)), String(b_(bg)));
  return `${CSI}${p.join(';')}m`;
}

export const RESET = `${CSI}0m`;
export const moveTo = (x, y) => `${CSI}${y + 1};${x + 1}H`;
export const CLEAR_ALL = `${CSI}2J`;
export const HOME = `${CSI}H`;
export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;
export const CURSOR_STEADY_BAR = `${CSI}6 q`;
export const CURSOR_DEFAULT = `${CSI}0 q`;
export const SAVE_CURSOR = `${CSI}s`;
export const RESTORE_CURSOR = `${CSI}u`;
// Terminals that implement synchronized output present the whole diff only
// after the logical cursor has been restored. Unsupported terminals ignore it.
export const SYNC_START = `${CSI}?2026h`;
export const SYNC_END = `${CSI}?2026l`;
export const ALT_ON = `${CSI}?1049h`;
export const ALT_OFF = `${CSI}?1049l`;
export const WRAP_OFF = `${CSI}?7l`;
export const WRAP_ON = `${CSI}?7h`;
// Button/wheel/motion reporting (1003 = any-motion) in SGR encoding (1006).
// Any-motion is a real cost: it emits an event per cell the pointer crosses and
// it takes text selection away from the terminal. We pay it because the nav rail
// is hover-driven, and the frame diff means a move that changes nothing costs
// nothing to draw. Motion events are dropped early unless they land on the rail.
export const MOUSE_ON  = `${CSI}?1000h${CSI}?1003h${CSI}?1006h`;
export const MOUSE_OFF = `${CSI}?1006l${CSI}?1003l${CSI}?1000l`;

/** Copy UTF-8 text through the terminal clipboard protocol (OSC 52). */
export function clipboardSequence(text) {
  const value = String(text ?? '');
  if (!value) return '';
  return `${ESC}]52;c;${Buffer.from(value, 'utf8').toString('base64')}\x07`;
}

export function copyToClipboard(text, out = process.stdout) {
  const sequence = clipboardSequence(text);
  if (!sequence) return false;
  out.write(sequence);
  return true;
}

/** Display width of a code point: 2 for CJK/fullwidth, 0 for combining, else 1. */
export function charWidth(cp) {
  if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f) || cp === 0xfe0f) return 0;
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Total display width of a string. */
export function strWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}
