// Raw-mode key decoder. Emits normalized {name, ctrl, alt, shift, seq} events.

import { StringDecoder } from 'node:string_decoder';

const NAMED = {
  '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\b': 'backspace',
  '\x1b': 'escape', ' ': 'space',
};

const CSI_MAP = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
  I: 'focusin', O: 'focusout',
  Z: 'tab', // shift-tab
  '5~': 'pageup', '6~': 'pagedown', '1~': 'home', '4~': 'end', '3~': 'delete',
  '2~': 'insert',
};

// SGR mouse button codes. Bit 6 (64) marks a wheel event; low bits pick direction.
function decodeMouse(btn, col, row, fin) {
  const mods = { ctrl: !!(btn & 16), alt: !!(btn & 8), shift: !!(btn & 4) };
  if (btn & 64) {
    const dir = btn & 3; // 0 = up, 1 = down
    if (dir > 1) return null; // horizontal wheel: ignore
    return {
      name: dir === 0 ? 'wheelup' : 'wheeldown',
      mouse: true, x: col - 1, y: row - 1, ...mods, seq: '',
    };
  }
  // SGR uses a lowercase final byte for release. Keep it as a first-class event
  // so drag selection can copy on release instead of guessing from motion gaps.
  if (fin === 'm') {
    return { name: 'mouseup', mouse: true, x: col - 1, y: row - 1, ...mods, seq: '' };
  }
  // Bit 5 (32) marks motion. 35 is button-less hover; low bits 0 mean the
  // left button is held, which the app needs for terminal-style text selection.
  if (btn & 32) {
    const dragging = (btn & 3) === 0;
    return {
      name: dragging ? 'mousedrag' : 'mousemove',
      mouse: true, dragging, x: col - 1, y: row - 1, ...mods, seq: '',
    };
  }
  // Plain press. Only left-button press is useful to us.
  if (fin === 'M' && (btn & 3) === 0) {
    return { name: 'mousedown', mouse: true, x: col - 1, y: row - 1, ...mods, seq: '' };
  }
  return null;
}

function decodeText(s, streaming = false) {
  const out = [];
  let i = 0;

  while (i < s.length) {
    const c = s[i];

    if (c === '\x1b') {
      // A control sequence can be split at any byte boundary by stdin. In stream
      // mode retain an incomplete prefix for the next chunk instead of emitting
      // Escape/Alt and leaking the remaining "<35;…M" bytes into the composer.
      if (streaming && i + 1 >= s.length) break;
      // SGR mouse: ESC [ < btn ; col ; row (M press | m release)
      if (s[i + 1] === '[' && s[i + 2] === '<') {
        const mm = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s.slice(i));
        if (mm) {
          const btn = parseInt(mm[1], 10);
          const ev = decodeMouse(btn, parseInt(mm[2], 10), parseInt(mm[3], 10), mm[4]);
          if (ev) out.push(ev);
          i += mm[0].length;
          continue;
        }
        if (streaming && /^\x1b\[<[0-9;]*$/.test(s.slice(i))) break;
      }
      // CSI
      if (s[i + 1] === '[') {
        const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(s.slice(i));
        if (m) {
          const [, params, fin] = m;
          const key = CSI_MAP[fin] ?? CSI_MAP[`${params}${fin}`];
          const mods = params.includes(';') ? parseInt(params.split(';')[1], 10) - 1 : 0;
          out.push({
            name: key ?? 'unknown',
            ctrl: !!(mods & 4),
            alt: !!(mods & 2),
            shift: !!(mods & 1) || fin === 'Z',
            seq: m[0],
          });
          i += m[0].length;
          continue;
        }
        if (streaming && /^\x1b\[[0-9;?]*$/.test(s.slice(i))) break;
      }
      // SS3 (application cursor keys)
      if (s[i + 1] === 'O') {
        if (streaming && i + 2 >= s.length) break;
        const fin = s[i + 2];
        const key = CSI_MAP[fin];
        if (key) {
          out.push({ name: key, ctrl: false, alt: false, shift: false, seq: s.slice(i, i + 3) });
          i += 3;
          continue;
        }
      }
      // alt+<char>
      if (i + 1 < s.length && s[i + 1] !== '\x1b') {
        out.push({ name: s[i + 1], ctrl: false, alt: true, shift: false, seq: s.slice(i, i + 2) });
        i += 2;
        continue;
      }
      out.push({ name: 'escape', ctrl: false, alt: false, shift: false, seq: c });
      i += 1;
      continue;
    }

    // ctrl+letter
    const code = c.charCodeAt(0);
    if (code < 27 && !NAMED[c]) {
      out.push({
        name: String.fromCharCode(code + 96),
        ctrl: true, alt: false, shift: false, seq: c,
      });
      i += 1;
      continue;
    }

    if (NAMED[c]) {
      out.push({ name: NAMED[c], ctrl: false, alt: false, shift: false, seq: c });
      i += 1;
      continue;
    }

    // printable — consume a full code point (surrogate pairs, combining marks)
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    out.push({ name: ch, ctrl: false, alt: false, shift: false, seq: ch, printable: true });
    i += ch.length;
  }
  return { events: out, rest: s.slice(i) };
}

export function decode(chunk) {
  return decodeText(chunk.toString('utf8'), false).events;
}

export function attach(onKey, stdin = process.stdin) {
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const utf8 = new StringDecoder('utf8');
  let pending = '';
  let flushTimer = null;

  const flushPending = () => {
    flushTimer = null;
    if (!pending) return;
    const parsed = decodeText(pending, false);
    pending = '';
    for (const k of parsed.events) onKey(k);
  };
  const handler = (chunk) => {
    if (flushTimer) clearTimeout(flushTimer);
    pending += utf8.write(chunk);
    const parsed = decodeText(pending, true);
    pending = parsed.rest;
    for (const k of parsed.events) onKey(k);
    // A bare Escape is a valid key as well as a control-sequence prefix. Give
    // the terminal one short packet window, then deliver it if no suffix arrives.
    if (pending) flushTimer = setTimeout(flushPending, 24);
  };
  stdin.on('data', handler);
  return () => {
    if (flushTimer) clearTimeout(flushTimer);
    const tail = utf8.end();
    if (tail) pending += tail;
    flushPending();
    stdin.off('data', handler);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };
}
