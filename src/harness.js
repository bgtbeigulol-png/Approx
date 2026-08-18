// Harness bridge — a generic newline-delimited-JSON channel that lets an external
// driver run the TUI. It knows nothing about the embedded runtime; that runtime is
// just one driver that speaks
// this protocol. The bridge exists because the interesting seam in this project is
// "who produces the reply text": normally it is the scripted `replyTo`, but a
// driver can either watch the conversation or take over as the backend.
//
// Wire format: one JSON object per line, both directions.
//
//   driver → app   (commands, field `cmd`)
//     {"cmd":"hello"}                         handshake; app replies with caps
//     {"cmd":"attach"}                        driver becomes the backend: from now
//                                             on a user submit only emits an event,
//                                             the scripted reply is suppressed
//     {"cmd":"detach"}                        hand the backend back to the script
//     {"cmd":"submit","text":"..."}           inject a user turn (as if typed)
//     {"cmd":"say","text":"...","cps":190}    stream an assistant reply
//     {"cmd":"system","text":"..."}           push a system line
//     {"cmd":"tool","name":"..","meta":"..","text":"..","dur":1200}
//     {"cmd":"set","key":"autoCompactMode","value":"tokens"}  write a setting
//     {"cmd":"interrupt"}                     stop any in-flight stream/tool
//     {"cmd":"clear"}                         clear the transcript
//     {"cmd":"frame","cols":96,"rows":30}     dump one ANSI frame (for screen grab)
//     {"cmd":"snapshot"}                      dump the transcript as structured JSON
//     {"cmd":"ping"}                          {"event":"pong"}
//     {"cmd":"quit"}
//
//   app → driver   (events, field `event`)
//     {"event":"ready","version":"<package version>","caps":[...]}
//     {"event":"submit","text":"..."}         a user turn landed (typed or injected)
//     {"event":"needReply","text":"..."}      driver is attached; produce a reply
//     {"event":"streamEnd"}                   an assistant stream finished
//     {"event":"setting","key":"..","value":..}
//     {"event":"frame","cols":..,"rows":..,"ansi":"..."}
//     {"event":"snapshot","msgs":[{role,text,...}]}
//     {"event":"error","message":"..."}
//     {"event":"pong"} / {"event":"bye"}
//
// The app stays fully live under all of this: injected turns stream through the
// same renderer, so a driver gets the real animation, not a stubbed one.

import { readFileSync } from 'node:fs';
import { APPROX_VERSION } from './version.js';

const CAPS = ['submit', 'say', 'system', 'tool', 'set', 'attach', 'frame', 'snapshot', 'interrupt', 'clear'];

export class Harness {
  /**
   * @param app   the App instance to drive
   * @param opts.in   readable stream of commands (default process.stdin)
   * @param opts.out  writable stream for events (default process.stdout)
   */
  constructor(app, { input = process.stdin, out = process.stdout } = {}) {
    this.app = app;
    this.in = input;
    this.out = out;
    this.buf = '';
    this.attached = false; // true once a driver claims the backend
    this._onData = (chunk) => this.feed(chunk);
  }

  start() {
    this.in.setEncoding('utf8');
    this.in.on('data', this._onData);
    this.in.on('end', () => this.emit({ event: 'bye' }));
    this.in.resume();
    this.emit({ event: 'ready', version: APPROX_VERSION, caps: CAPS });
    return this;
  }

  stop() {
    this.in.off('data', this._onData);
  }

  emit(obj) {
    try {
      this.out.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // a broken pipe on the driver side must not take the TUI down
    }
  }

  /** Feed raw text; splits on newlines and dispatches each complete line. */
  feed(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.dispatch(line);
    }
  }

  dispatch(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.emit({ event: 'error', message: 'bad json' });
    }
    try {
      this.handle(msg);
    } catch (e) {
      this.emit({ event: 'error', message: String(e.message ?? e) });
    }
  }

  handle(msg) {
    const app = this.app;
    switch (msg.cmd) {
      case 'hello':
        return this.emit({ event: 'ready', version: APPROX_VERSION, caps: CAPS, attached: this.attached });
      case 'ping':
        return this.emit({ event: 'pong' });
      case 'attach':
        this.attached = true;
        return this.emit({ event: 'attached' });
      case 'detach':
        this.attached = false;
        return this.emit({ event: 'detached' });
      case 'submit':
        return app.submitText(String(msg.text ?? ''), 'harness');
      case 'say':
        app.beginStream(String(msg.text ?? ''), clampCps(msg.cps));
        return;
      case 'system':
        app.push({ role: 'system', text: String(msg.text ?? '') });
        app.scrollToBottom();
        return;
      case 'tool':
        return app.injectTool(msg);
      case 'set':
        return app.applyHarnessSetting(String(msg.key), msg.value);
      case 'interrupt':
        return app.interrupt();
      case 'clear':
        return app.clearTranscript();
      case 'frame':
        return this.emit({ event: 'frame', ...app.dumpFrame(msg.cols, msg.rows) });
      case 'snapshot':
        return this.emit({ event: 'snapshot', msgs: app.snapshot() });
      case 'quit':
        this.emit({ event: 'bye' });
        return app.quit();
      default:
        return this.emit({ event: 'error', message: `unknown cmd: ${msg.cmd}` });
    }
  }
}

function clampCps(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 190;
  return Math.max(20, Math.min(2000, n));
}

/**
 * Parse a `--script FILE` of NDJSON commands into an array, for a non-interactive
 * driver that just wants to seed a scene (used by tests and the shot script).
 */
export function loadScript(path) {
  const raw = readFileSync(path, 'utf8');
  return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}
