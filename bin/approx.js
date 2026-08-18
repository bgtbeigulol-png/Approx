#!/usr/bin/env node
// Approx — brutalist condensed-milk TUI.

import { runUpdateCommand } from '../src/updater.js';
import { createUpdatePanel } from '../src/update-tui.js';
import { APPROX_VERSION } from '../src/version.js';

const argv = process.argv.slice(2);
const has = (...names) => names.some((name) => argv.includes(name));

const command = argv[0]?.toLowerCase();

if (has('-v', '--version')) {
  process.stdout.write(`${APPROX_VERSION}\n`);
} else if (command === 'update' && has('-h', '--help')) {
  process.stdout.write(`usage: approx update\n\nCheck the active Git or npm channel and install its newest release.\n`);
} else if (command === 'update') {
  const panel = createUpdatePanel();
  let outcome;
  try {
    outcome = await runUpdateCommand({
      write: panel ? () => {} : undefined,
      progress: panel ? (event) => panel.step(event) : undefined,
    });
  } finally {
    await panel?.close();
  }
  process.exitCode = outcome.ok ? 0 : 1;
} else {
  await runApp();
}

async function runApp() {
  if (has('-h', '--help')) {
    process.stdout.write(`Approx — a brutalist TUI shell

usage: approx [options]
       approx update

  update         install the newest Git or npm release
  --no-splash    skip the boot animation
  --scripted     use the offline scripted demo instead of Pi
  --live         compatibility alias; Pi is now the default
  --continue     continue Approx's most recent session for this directory
  --harness      accept an NDJSON driver on stdin (events on stderr)
  -h, --help     this text
  -v, --version  print the installed version

keys: ^p palette · ^o settings · ^g jump · / commands · ↵ send · ^c quit
`);
    return;
  }

  const harness = has('--harness');
  const scripted = has('--scripted');
  // --pi remains an undocumented compatibility alias for existing launch scripts.
  const liveAlias = has('--live', '--pi');
  const pi = !harness && !scripted;

  if ((harness && (scripted || liveAlias)) || (scripted && liveAlias)) {
    process.stderr.write('approx: --harness, --scripted, and --live are separate backend modes\n');
    process.exitCode = 1;
    return;
  }

  // The standalone updater intentionally runs before this guard. Updating does
  // not need an interactive terminal, while the TUI still does.
  if (!process.stdout.isTTY && !harness) {
    process.stderr.write('approx: needs an interactive terminal (stdout is not a TTY)\n');
    process.stderr.write('        (pass --harness to drive it over stdin instead)\n');
    process.exitCode = 1;
    return;
  }

  const { run } = await import('../src/app.js');
  // Windows launchers preserve the directory where the user invoked Approx.
  const launchDir = process.env.APPROX_START_DIR || null;
  await run({
    noSplash: has('--no-splash'),
    harness,
    pi,
    continueSession: has('--continue', '-c'),
    launchDir,
  });
}
