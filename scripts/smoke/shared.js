// Shared dependencies and assertions for the headless smoke suites.

export { Screen, enterTui } from '../../src/screen.js';
export { attach, decode } from '../../src/input.js';
export { wrapText, ellipsize, padTo } from '../../src/wrap.js';
export {
  strWidth, rgb, mix, moveTo, HIDE_CURSOR, SHOW_CURSOR, CURSOR_STEADY_BAR,
  SAVE_CURSOR, RESTORE_CURSOR, SYNC_START, SYNC_END, clipboardSequence,
} from '../../src/ansi.js';
export { Spring, Tween, ease, clamp } from '../../src/anim.js';
export { drawSplash, SPLASH_MS } from '../../src/ui/splash.js';
export { drawPalette, fuzzy, filterCommands, paletteLayout } from '../../src/ui/palette.js';
export { drawTranscript, layout, totalHeight, visibleLines } from '../../src/ui/transcript.js';
export { drawGit } from '../../src/ui/git.js';
export { buildFileChanges } from '../../src/file-changes.js';
export { parseGitStatus } from '../../src/git.js';
export { railTicks, tickAtRow, tickLabel, RAIL_W } from '../../src/ui/rail.js';
export { settingsModel, settingsRows, applySetting } from '../../src/settings.js';
export { drawJumpList, jumpResults, jumpLabel, jumpLayout, logicalTimeline } from '../../src/ui/jumplist.js';
export { drawComposer } from '../../src/ui/composer.js';
export { fileMentionSpans } from '../../src/file-mention-highlight.js';
export { drawCompact } from '../../src/ui/compact.js';
export { drawPlanPanel } from '../../src/ui/plan.js';
export {
  layoutComposerInput, setComposerInput, insertComposerText, moveComposerCursor,
} from '../../src/composer-state.js';
export {
  applyPlanOperation, buildPlanTurnInjection, createPlanState, serializePlanState,
} from '../../src/plan.js';
export { createApproxHostTools } from '../../src/pi-host-tools.js';
export {
  createApprodeState, approdeRows, navigableRows, APPRODE_MAX_PRESETS,
} from '../../src/approde.js';
export { loadPreferences, savePreferences } from '../../src/persistence.js';
export { Harness } from '../../src/harness.js';
export { App } from '../../src/app.js';
export { createAppState } from '../../src/app-state.js';
export { PiBackend } from '../../src/backends/pi.js';
export { toolMessages } from '../../src/message-tree.js';
export { T, paper, drawPaperGrain } from '../../src/theme.js';
export { EventEmitter } from 'node:events';
export { spawnSync } from 'node:child_process';
export { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
export { tmpdir } from 'node:os';
export { join } from 'node:path';

export const SAMPLE_LONG = 'The renderer keeps two cell buffers and compares them per cell. '.repeat(6);

let pass = 0;
const failures = [];
const errors = [];

export function ok(name, condition) {
  if (condition) pass++;
  else failures.push(name);
}

export function recordError(label, error) {
  if (error) errors.push({ label, error });
}

export class FakeOut {
  constructor(w = 100, h = 32) {
    this.columns = w;
    this.rows = h;
    this.isTTY = true;
    this.buf = '';
    this.writes = 0;
  }

  write(value) {
    this.buf += value;
    this.writes++;
    return true;
  }

  on() {}
}

export function report() {
  for (const item of errors) console.error(`\n${item.label} error:`, item.error.stack);
  console.log(`\napprox smoke: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.log(`  FAIL  ${failure}`);
    process.exit(1);
  }
  process.exit(0);
}
