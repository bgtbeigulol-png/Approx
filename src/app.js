// Approx application composition root and lifecycle.

import { Screen, enterTui, exitTui } from './screen.js';
import { attach } from './input.js';
import { Harness } from './harness.js';
import { Clock } from './anim.js';
import { RESET } from './ansi.js';
import { T } from './theme.js';
import { buildCommands } from './commands.js';
import { GREETING } from './content.js';
import { loadPreferences } from './persistence.js';
import { sessionMethods } from './sessions.js';
import { navigationMethods } from './navigation.js';
import { queueMethods } from './queue.js';
import { runtimeSettingMethods } from './runtime-settings.js';
import { backendBridgeMethods } from './backend-bridge.js';
import { directoryMethods, sameDirectory } from './directories.js';
import { planMethods } from './plan.js';
import { questionnaireMethods } from './questionnaire.js';
import { inputMethods } from './app-input.js';
import { renderMethods } from './app-render.js';
import { turnMethods } from './app-turns.js';
import { transcriptMethods } from './app-transcript.js';
import { interactionMethods } from './app-interaction.js';
import { APP_ACCENTS, createAppState } from './app-state.js';

export class App {
  constructor({ noSplash = false, harness = false, backend = null, persist = false } = {}) {
    this.s = new Screen(process.stdout);
    // Frame rate is locked at 60: the motion is tuned for it and a live rate
    // switch was more trouble than it was worth.
    this.clock = new Clock(60);
    this.detach = null;
    this.alive = true;
    // When a harness owns stdin for its NDJSON command stream, the keyboard decoder
    // must not also claim stdin or the two fight over every byte.
    this.harnessDriven = harness;
    this.backend = backend;
    this.backendUnsubscribe = backend?.subscribe((event) => this.onBackendEvent(event)) ?? null;
    this.liveAssistant = null;
    this.liveTools = new Map();
    this._pendingLiveDelta = '';
    this._tokenEvents = [];
    this._toolGroupSeq = 0;
    this._queueSeq = 0;
    this._turnSeq = 0;
    this._activeTurn = null;

    this.persistenceEnabled = !!persist;
    this.preferences = this.persistenceEnabled ? loadPreferences() : {};
    const initialCwd = backend?.cwd ?? process.cwd();
    this.st = createAppState({
      noSplash, backend, preferences: this.preferences, initialCwd,
    });

    // The settings view rebuilds its model each frame and needs the app; stash a
    // back-reference on state so the render path can stay a plain (screen, state) call.
    this.st._app = this;
    T.accent = APP_ACCENTS[this.st.accent];

    this.cmds = buildCommands(this);
    this.timers = new Set();
    this.harness = null; // set by the harness bridge when a driver attaches
  }

  // ---------- lifecycle ----------

  start() {
    enterTui();
    if (!this.harnessDriven) this.detach = attach((k) => this.onKey(k));
    process.stdout.on('resize', () => this.onResize());
    process.on('SIGINT', () => this.quit());
    this.clock.start((dt, t, frame) => this.tick(dt, t, frame));
    if (this.st.phase === 'main' && !this.st.msgs.length) this.seed();
    return this;
  }

  /**
   * Attach a harness bridge. The driver reads events on `out` and writes commands
   * on `input`; keep those off the TTY (stderr for events, a pipe for commands) so
   * the alt-screen render on stdout stays clean.
   */
  attachHarness(harness) {
    this.harness = harness;
    harness.start();
    return this;
  }

  quit() {
    if (!this.alive) return;
    this.alive = false;
    this.clock.stop();
    for (const id of this.timers) clearTimeout(id);
    if (this.detach) this.detach();
    this.backendUnsubscribe?.();
    this.backend?.dispose();
    exitTui();
    process.stdout.write(`${RESET}\n`);
    process.exit(0);
  }

  later(fn, ms) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (this.alive) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  seed() {
    const greeting = this.backend
      ? `${this.st.runtime} connected · ${this.st.model}\nSession ${this.st.sessionId || 'ready'} · models, tools, context, and persistence are live.`
      : GREETING;
    this.push({ role: 'system', text: greeting });
  }
}

Object.assign(App.prototype, transcriptMethods);

Object.assign(App.prototype, interactionMethods);

Object.assign(App.prototype, queueMethods);
Object.assign(App.prototype, directoryMethods, planMethods, questionnaireMethods);
Object.assign(App.prototype, inputMethods);
// ---------- overlays ----------

Object.assign(App.prototype, navigationMethods);

Object.assign(App.prototype, turnMethods);

Object.assign(App.prototype, runtimeSettingMethods);
Object.assign(App.prototype, backendBridgeMethods);

Object.assign(App.prototype, renderMethods);

Object.assign(App.prototype, sessionMethods);

export async function run(opts = {}) {
  let backend = opts.backend ?? null;
  if (!backend && opts.pi) {
    const { PiBackend } = await import('./backends/pi.js');
    backend = new PiBackend({
      cwd: process.cwd(),
      continueSession: !!opts.continueSession,
    });
  }

  const app = new App({ ...opts, backend, persist: opts.persist !== false });
  if (backend?.start) await backend.start();
  // The Windows launchers cd into the approx tree before node runs, so this
  // process starts in the approx root. They record the terminal's original
  // directory as APPROX_START_DIR; land there through the same folder-switch
  // path the picker uses, so sessions and tools are rooted at the directory
  // the user actually launched approx from.
  if (opts.launchDir && !sameDirectory(opts.launchDir, process.cwd())) {
    await app.switchDirectory(opts.launchDir);
  }
  app.start();
  if (opts.harness) {
    // Events go to stderr so stdout stays a clean render target for a screen grab;
    // commands arrive on stdin. A driver that wants both frames and events reads
    // stderr for the protocol and can pull frames on demand via the `frame` command.
    app.attachHarness(new Harness(app, { input: process.stdin, out: process.stderr }));
  }
  return app;
}
