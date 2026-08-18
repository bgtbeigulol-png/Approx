// End-to-end updater checks: a real temporary Git remote plus an isolated npm runner.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  applyGitUpdate,
  applyUpdate,
  checkForGitUpdate,
  checkForNpmUpdate,
  checkForUpdate,
  compareVersions,
  runUpdateCommand,
} from '../src/updater.js';
import { updaterMethods } from '../src/app-updater.js';
import { transcriptMethods } from '../src/app-transcript.js';
import { createUpdatePanel } from '../src/update-tui.js';

const execFileAsync = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'approx-updater-'));
let assertions = 0;

const ok = (condition, message) => {
  assert.ok(condition, message);
  assertions++;
};

class PanelOut extends EventEmitter {
  constructor() {
    super();
    this.columns = 84;
    this.rows = 22;
    this.isTTY = true;
    this.buf = '';
  }

  write(chunk) {
    this.buf += String(chunk ?? '');
    return true;
  }
}

try {
  process.stdout.write('[1/9] create a temporary Git release channel\n');
  const remote = join(root, 'remote.git');
  const publisher = join(root, 'publisher');
  const checkout = join(root, 'checkout');
  mkdirSync(publisher, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', remote], root);
  await git(['init', '--initial-branch=main'], publisher);
  await git(['config', 'user.email', 'updater@example.test'], publisher);
  await git(['config', 'user.name', 'Approx Updater Test'], publisher);
  writePackage(publisher, '1.0.0');
  await git(['add', 'package.json'], publisher);
  await git(['commit', '-m', 'release 1.0.0'], publisher);
  await git(['remote', 'add', 'origin', remote], publisher);
  await git(['push', '--set-upstream', 'origin', 'main'], publisher);
  await git(['clone', '--branch', 'main', remote, checkout], root);

  writePackage(publisher, '1.1.0');
  await git(['add', 'package.json'], publisher);
  await git(['commit', '-m', 'release 1.1.0'], publisher);
  await git(['push', 'origin', 'main'], publisher);

  process.stdout.write('[2/9] check and apply the Git update workflow\n');
  const gitCheck = await checkForGitUpdate({ cwd: checkout });
  ok(gitCheck.available && gitCheck.channel === 'git', 'Git check should find the remote release');
  ok(gitCheck.commits === 1 && gitCheck.version === '1.1.0', 'Git check should report commit and version');
  ok(gitCheck.upstream === 'origin/main', 'Git check should resolve the configured upstream');

  writeFileSync(join(checkout, 'dirty.txt'), 'local work\n', 'utf8');
  const dirtyResult = await applyGitUpdate({ cwd: checkout, check: gitCheck, npmRunner: fakeDependencyInstall });
  ok(!dirtyResult.updated && dirtyResult.reason === 'dirty-worktree', 'Git apply should preserve dirty worktrees');
  unlinkSync(join(checkout, 'dirty.txt'));

  const dependencyCalls = [];
  const gitResult = await applyGitUpdate({
    cwd: checkout,
    check: gitCheck,
    npmRunner: async (args) => {
      dependencyCalls.push(args);
      return '';
    },
  });
  ok(gitResult.updated && gitResult.version === '1.1.0', 'Git apply should fast-forward to the release');
  ok(gitResult.dependenciesInstalled, 'Git apply should synchronize dependencies');
  ok(dependencyCalls[0]?.[0] === 'install' && !dependencyCalls[0].includes('--global'),
    'source updates should install project dependencies locally');
  ok(JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version === '1.1.0',
    'updated checkout should contain the remote package version');
  const secondGitCheck = await checkForGitUpdate({ cwd: checkout });
  ok(!secondGitCheck.available && secondGitCheck.commits === 0, 'second Git check should be up to date');

  process.stdout.write('[3/9] emulate npm dist-tags and select the newest release\n');
  const npmRoot = join(root, 'npm-install');
  mkdirSync(npmRoot, { recursive: true });
  writePackage(npmRoot, '1.0.0');
  const npmCalls = [];
  const npmRunner = async (args) => {
    npmCalls.push(args);
    if (args[0] === 'view') return JSON.stringify({ latest: '1.1.0', beta: '1.2.0-beta.1' });
    if (args[0] === 'install') return 'installed';
    throw new Error(`unexpected npm command: ${args.join(' ')}`);
  };
  const npmCheck = await checkForUpdate({ cwd: npmRoot, npmRunner });
  ok(npmCheck.channel === 'npm' && npmCheck.available, 'non-Git installs should use npm');
  ok(npmCheck.version === '1.2.0-beta.1' && npmCheck.tag === 'beta',
    'npm check should select the newest version across published tags');

  process.stdout.write('[4/9] apply the npm global update workflow\n');
  const npmResult = await applyUpdate({ cwd: npmRoot, check: npmCheck, npmRunner });
  ok(npmResult.updated && npmResult.channel === 'npm', 'npm release should install successfully');
  const globalInstall = npmCalls.find((args) => args[0] === 'install');
  ok(globalInstall?.includes('--global'), 'npm updater should use a global install');
  ok(globalInstall?.includes('@bgtbeigulol-png/approx@1.2.0-beta.1'),
    'npm updater should pin the exact checked release');

  process.stdout.write('[5/9] run the standalone approx update command workflow\n');
  const output = [];
  const progressEvents = [];
  const cliResult = await runUpdateCommand({
    cwd: npmRoot,
    npmRunner,
    write: (text) => output.push(text),
    progress: (event) => progressEvents.push(event),
  });
  ok(cliResult.ok && cliResult.updated, 'standalone updater should complete the npm workflow');
  ok(output.join('').includes('via npm') && output.join('').includes('Restart Approx'),
    'standalone updater should report channel and restart requirement');
  ok(progressEvents[0]?.status === 'run' && progressEvents.at(-1)?.done
    && progressEvents.at(-1)?.status === 'ok',
  'standalone updater should expose structured progress for the TTY panel');

  process.stdout.write('[6/9] validate version ordering and failure reporting\n');
  ok(compareVersions('1.2.0', '1.2.0-beta.2') > 0, 'stable release should outrank its prerelease');
  ok(compareVersions('1.2.0-beta.10', '1.2.0-beta.2') > 0, 'numeric prerelease identifiers should sort numerically');
  const failedCheck = await checkForNpmUpdate({
    cwd: npmRoot,
    npmRunner: async () => { throw new Error('registry fixture offline'); },
  });
  ok(failedCheck.reason === 'check-failed' && failedCheck.error.includes('registry fixture offline'),
    'registry failures should remain failures instead of reporting up to date');

  process.stdout.write('[7/9] verify metadata commands without entering the TUI or updater\n');
  const cliPath = resolve('bin/approx.js');
  const packageVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
  const versionResult = await execFileAsync(process.execPath, [cliPath, '--version'], { windowsHide: true });
  ok(versionResult.stdout.trim() === packageVersion && !versionResult.stderr,
    '--version should work over a pipe without entering the TUI');
  const updateHelp = await execFileAsync(process.execPath, [cliPath, 'update', '--help'], { windowsHide: true });
  ok(updateHelp.stdout.startsWith('usage: approx update') && !updateHelp.stdout.includes('checking for'),
    'update --help should describe the command without checking the network');

  process.stdout.write('[8/9] verify in-app progress, completion, and error feedback\n');
  const feedback = feedbackHost();
  feedback._checkForUpdate = async () => ({
    available: false, channel: 'npm', currentVersion: '1.2.0', version: '1.2.0',
  });
  await feedback.checkForUpdates({ force: true });
  ok(!feedback.st.update.checking && feedback.st.update.info.currentVersion === '1.2.0',
    'in-app check should retain a completed result');
  ok(feedback.st.toast.includes('up to date via npm') && feedback.st.toastKind === 'ok',
    'in-app check should show an up-to-date result');
  ok(feedback.frames >= 2 && feedback.invalidations >= 2,
    'async updater feedback should wake and invalidate the renderer');

  feedback._checkForUpdate = async () => ({
    available: false, channel: 'npm', reason: 'check-failed', error: 'registry fixture offline',
  });
  await feedback.checkForUpdates({ force: true });
  ok(feedback.st.toast.includes('check failed') && feedback.st.toastKind === 'warn',
    'in-app registry errors should be visibly reported as failures');

  feedback._checkForUpdate = async () => { throw new Error('checker crashed'); };
  const thrownCheck = await feedback.checkForUpdates({ force: true });
  ok(thrownCheck.reason === 'check-failed' && feedback.st.update.info.error === 'checker crashed'
    && feedback.st.toast.includes('update check failed'),
  'thrown in-app check errors should persist a visible failure state');

  feedback._checkForUpdate = async () => ({
    available: false, channel: 'git', currentVersion: '1.2.0', version: '1.2.0',
  });
  feedback.commandUpdate();
  await feedback._updateCheck;
  ok(feedback.st.toast.includes('up to date via git'),
    '/update command should expose its completed check result');

  feedback._applyAvailableUpdate = async () => ({ updated: true, channel: 'npm', version: '1.3.0' });
  await feedback.applyUpdate();
  ok(feedback.st.update.info.updated && feedback.st.toast.includes('updated via npm'),
    'in-app install should retain and announce its completion state');

  feedback._applyAvailableUpdate = async () => { throw new Error('installer crashed'); };
  const thrownInstall = await feedback.applyUpdate();
  ok(!feedback.st.update.updating && thrownInstall.reason === 'update-failed'
    && feedback.st.update.info.error === 'installer crashed' && feedback.st.toast.includes('update stopped'),
  'thrown in-app install errors should clear progress and persist a visible failure state');

  process.stdout.write('[9/9] verify the standalone update panel lifecycle\n');
  const panelOut = new PanelOut();
  const panel = createUpdatePanel(panelOut, { holdMs: 0 });
  panel.step({ id: 'check', label: 'Checking release channel', status: 'run' });
  panel.step({ id: 'check', label: 'Approx 0.1.1 is ready', status: 'ok', done: true });
  await panel.close();
  ok(panel.closed && panelOut.buf.includes('APPROX UPDATE')
    && panelOut.buf.includes('\u001b[?25l') && panelOut.buf.includes('\u001b[?25h'),
  'TTY updater panel should render a result and restore the cursor');

  process.stdout.write(`updater workflow: ${assertions} assertions passed\n`);
} finally {
  const tempBase = `${resolve(tmpdir())}${sep}`.toLowerCase();
  const target = resolve(root).toLowerCase();
  if (!target.startsWith(tempBase) || !target.includes('approx-updater-')) {
    throw new Error(`refusing to clean unexpected updater fixture: ${root}`);
  }
  rmSync(root, { recursive: true, force: true });
}

async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 512 * 1024,
  });
  return String(stdout || '').trim();
}

function writePackage(directory, version) {
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
    name: '@bgtbeigulol-png/approx',
    version,
    type: 'module',
  }, null, 2)}\n`, 'utf8');
}

async function fakeDependencyInstall() {
  return '';
}

function feedbackHost() {
  const host = {
    st: {
      update: { checking: false, updating: false, checkedAt: 0, info: null },
      toast: null,
      toastKind: 'info',
      toastLife: 0,
      toastMax: 2.4,
    },
    preferences: {},
    frames: 0,
    invalidations: 0,
    persisted: 0,
    s: { invalidate() { host.invalidations++; } },
    requestFrame() { host.frames++; },
    persistPreferences() { host.persisted++; },
    toast: transcriptMethods.toast,
  };
  return Object.assign(host, updaterMethods);
}
