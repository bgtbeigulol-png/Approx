// `approx update` feedback panel. A small brutalist card that draws over the
// tail of the active terminal — no alt-screen, no input grab: the shell keeps
// its scrollback while the update runs, the card narrates the flow, and the
// finished card stays on screen as the visual result. The user's cursor is
// restored to its original prompt position via DECSC/DECRC.

import {
  DEFAULT, HIDE_CURSOR, SHOW_CURSOR, CURSOR_DEFAULT,
  SAVE_CURSOR, RESTORE_CURSOR,
} from './ansi.js';
import { ATTR_BOLD } from './ansi.js';
import { BLOCK, HEAVY, MARK, SPIN_BRAILLE } from './glyphs.js';
import { box } from './draw.js';
import { Screen } from './screen.js';
import { T, mix } from './theme.js';
import { clamp } from './anim.js';
import { ellipsize } from './wrap.js';

const TICK_MS = 50;
const DEFAULT_HOLD_MS = 900;

function sweepBar(s, x, y, w, t, fg, track, bg) {
  const head = ((t * 13) % (w + 6)) - 3;
  for (let i = 0; i < w; i++) {
    const distance = Math.abs(i - head);
    const glow = distance < 3 ? (1 - distance / 3) ** 2 : 0;
    s.put(x + i, y, BLOCK.full, mix(track, fg, glow), bg);
  }
}

/** Returns null when the stream is not a TTY so callers fall back to plain text. */
export function createUpdatePanel(out = process.stdout, { holdMs = DEFAULT_HOLD_MS } = {}) {
  if (!out?.isTTY) return null;
  return new UpdatePanel(out, holdMs);
}

class UpdatePanel {
  constructor(out, holdMs) {
    this.out = out;
    this.holdMs = holdMs;
    this.s = new Screen(out);
    this.seedBlank();
    this.steps = [];
    this.summary = '';
    this.doneAt = 0;
    this.closed = false;
    this.footprint = null;
    this.onSigint = () => {
      // Ctrl+C mid-update: erase the live card, put the cursor back, die.
      this.dispose(false);
      process.exit(130);
    };
    this.onResize = () => {
      this.s.resize(this.out.columns, this.out.rows);
      this.seedBlank();
      this.footprint = null;
      this.render();
    };
    process.once('SIGINT', this.onSigint);
    out.on('resize', this.onResize);
    // Remember where the user's prompt cursor sits; every frame writes with
    // absolute positioning, so it must be pinned back before we finish.
    out.write(SAVE_CURSOR + HIDE_CURSOR);
    this.timer = setInterval(() => this.render(), TICK_MS);
    this.timer.unref?.();
    this.render();
  }

  /** Previous-frame model starts as "blank terminal": we only ever diff our own cells. */
  seedBlank() {
    this.s.pch.fill(' ');
    this.s.pfg.fill(DEFAULT);
    this.s.pbg.fill(DEFAULT);
    this.s.pat.fill(0);
  }

  /** Consume one `{ id, label, status, done?, summary? }` step event. */
  step(event = {}) {
    if (this.closed) return;
    const id = String(event.id ?? '');
    if (!id) return;
    const status = ['run', 'ok', 'warn', 'info'].includes(event.status) ? event.status : 'info';
    const label = String(event.label ?? '');
    const existing = this.steps.find((item) => item.id === id);
    if (existing) {
      if (label) existing.label = label;
      existing.status = status;
    } else {
      this.steps.push({ id, label, status });
    }
    if (event.done) {
      this.summary = String(event.summary ?? existing?.label ?? label);
      this.doneAt = Date.now();
    }
    this.render();
  }

  /**
   * Hold the finished state briefly so the outcome registers, then detach. The
   * card itself stays on screen — it *is* the result — while the cursor returns
   * to the saved prompt position. The hold timer MUST stay ref'd: an unref'd
   * timer lets Node drain the event loop and exit past the pending top-level
   * await ("unsettled top-level await") before the cursor is restored.
   */
  async close() {
    if (this.closed) return;
    if (this.doneAt) {
      const remaining = this.holdMs - (Date.now() - this.doneAt);
      if (remaining > 0) await new Promise((resolve) => { setTimeout(resolve, remaining); });
    }
    this.render();
    this.dispose(true);
  }

  dispose(keepFrame) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    process.removeListener('SIGINT', this.onSigint);
    this.out.removeListener?.('resize', this.onResize);
    if (!keepFrame) this.erase();
    this.out.write(RESTORE_CURSOR + SHOW_CURSOR + CURSOR_DEFAULT);
  }

  geometry() {
    const s = this.s;
    const w = clamp(s.w - 4, 28, 64);
    // Reserve the very last row for the user's pending prompt line.
    const capacity = Math.min(8, Math.max(1, s.h - 4));
    const steps = this.steps.slice(-capacity);
    const h = steps.length + 2;
    return { x: Math.max(1, (s.w - w) >> 1), y: Math.max(0, s.h - h - 2), w, h, steps };
  }

  /** The bottom-right cell is a scroll trap: never write into it. */
  safe(x, y) {
    return !(x >= this.s.w - 1 && y >= this.s.h - 1);
  }

  erase() {
    const prev = this.footprint;
    if (!prev) return;
    // +1 row/col covers the offset hard shadow.
    for (let y = prev.y; y < prev.y + prev.h + 1 && y < this.s.h; y++) {
      for (let x = prev.x; x < prev.x + prev.w + 1 && x < this.s.w; x++) {
        if (this.safe(x, y)) this.s.put(x, y, ' ', DEFAULT, DEFAULT, 0);
      }
    }
    this.s.flush();
    this.footprint = null;
  }

  render() {
    if (this.closed) return;
    const s = this.s;
    const g = this.geometry();
    if (this.footprint && (this.footprint.x !== g.x || this.footprint.y !== g.y
      || this.footprint.w !== g.w || this.footprint.h !== g.h)) {
      this.erase();
    }
    const t = (Date.now() % 100_000) / 1000;
    const shadow = mix(T.bg, T.shadow, 0.34);
    for (let y = g.y + 1; y < g.y + g.h + 1 && y < s.h; y++) {
      for (let x = g.x + 1; x < g.x + g.w + 1 && x < s.w; x++) {
        if (this.safe(x, y)) s.put(x, y, ' ', shadow, shadow);
      }
    }
    for (let y = g.y; y < g.y + g.h; y++) {
      for (let x = g.x; x < g.x + g.w; x++) {
        if (this.safe(x, y)) s.put(x, y, ' ', T.fg, T.panel);
      }
    }
    box(s, g.x, g.y, g.w, g.h, HEAVY, T.rule, T.panel);
    s.text(g.x + 2, g.y, ' APPROX UPDATE ', T.bg, mix(T.panel, T.accent, 0.85), ATTR_BOLD, g.w - 4);
    for (let i = 0; i < g.steps.length; i++) this.drawStep(s, g, i, t);
    this.footprint = { ...g };
    s.flush();
  }

  drawStep(s, g, i, t) {
    const step = g.steps[i];
    const y = g.y + 1 + i;
    const running = step.status === 'run';
    const color = running ? T.accent
      : step.status === 'ok' ? T.ok : step.status === 'warn' ? T.warn : T.accent2;
    const glyph = running ? SPIN_BRAILLE[Math.floor(t * 12) % SPIN_BRAILLE.length]
      : step.status === 'ok' ? MARK.check : step.status === 'warn' ? MARK.cross : MARK.diamond;
    const emphasized = this.doneAt && i === g.steps.length - 1
      && (step.status === 'ok' || step.status === 'warn');
    const rowBg = emphasized ? mix(T.panel, color, 0.16) : T.panel;
    if (emphasized) {
      for (let x = g.x + 1; x < g.x + g.w - 1; x++) {
        if (this.safe(x, y)) s.put(x, y, ' ', T.fg, rowBg);
      }
    }
    if (this.safe(g.x + 2, y)) s.put(g.x + 2, y, glyph, color, rowBg, ATTR_BOLD);
    const barW = running && g.w > 26 ? 10 : 0;
    const room = Math.max(1, g.w - 6 - barW);
    s.text(g.x + 4, y, ellipsize(String(step.label ?? ''), room),
      mix(T.panel, running ? T.ink : T.slate, 1), rowBg,
      running || emphasized ? ATTR_BOLD : 0, room);
    if (barW) sweepBar(s, g.x + g.w - barW - 2, y, barW, t, T.accent, mix(T.panel, T.inset, 0.8), T.panel);
  }
}
