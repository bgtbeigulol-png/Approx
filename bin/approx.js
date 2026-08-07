#!/usr/bin/env node
// Approx — brutalist condensed-milk TUI.

import { run } from '../src/app.js';

const argv = process.argv.slice(2);
const has = (...names) => names.some((n) => argv.includes(n));

if (has('-h', '--help')) {
  process.stdout.write(`Approx — a brutalist TUI shell

usage: approx [options]

  --no-splash    skip the boot animation
  --scripted     use the offline scripted demo instead of Pi
  --live         compatibility alias; Pi is now the default
  --continue     continue Approx's most recent session for this directory
  --harness      accept an NDJSON driver on stdin (events on stderr)
  -h, --help     this text

keys: ^p palette · ^o settings · ^g jump · / commands · ↵ send · ^c quit
`);
  process.exit(0);
}

const harness = has('--harness');
const scripted = has('--scripted');
// --pi remains an undocumented compatibility alias for existing launch scripts.
const liveAlias = has('--live', '--pi');
const pi = !harness && !scripted;

if ((harness && (scripted || liveAlias)) || (scripted && liveAlias)) {
  process.stderr.write('approx: --harness, --scripted, and --live are separate backend modes\n');
  process.exit(1);
}

// The TTY guard is about interactive keyboard use. A harness driver supplies its
// own input over stdin, so it only needs a real terminal when a human is also
// meant to watch the render on stdout. Require the TTY unless we're harness-driven.
if (!process.stdout.isTTY && !harness) {
  process.stderr.write('approx: needs an interactive terminal (stdout is not a TTY)\n');
  process.stderr.write('        (pass --harness to drive it over stdin instead)\n');
  process.exit(1);
}

// The Windows launchers (approx.cmd / approx.ps1) cd into the approx tree
// before node runs, so the process would land in the approx root. They record
// the directory the terminal was in as APPROX_START_DIR; run() switches back
// to it through the app's folder-switch path.
const launchDir = process.env.APPROX_START_DIR || null;

await run({
  noSplash: has('--no-splash'),
  harness,
  pi,
  continueSession: has('--continue', '-c'),
  launchDir,
});
