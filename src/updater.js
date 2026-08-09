import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const UPDATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REMOTE = 'origin';
const DEFAULT_BRANCH = 'main';

export function readPackageMetadata(cwd = UPDATE_ROOT) {
  try {
    const value = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
    return {
      name: String(value?.name || '@bgtbeigulol-png/approx'),
      version: String(value?.version || '0.0.0'),
    };
  } catch {
    return { name: '@bgtbeigulol-png/approx', version: '0.0.0' };
  }
}

export function isGitCheckout(cwd = UPDATE_ROOT) {
  return existsSync(resolve(cwd, '.git'));
}

/** Check the update channel that matches this installation. */
export async function checkForUpdate(options = {}) {
  return isGitCheckout(options.cwd)
    ? checkForGitUpdate(options)
    : checkForNpmUpdate(options);
}

export async function checkForGitUpdate({
  cwd = UPDATE_ROOT,
  remote,
  branch,
  gitRunner = runGit,
} = {}) {
  if (!isGitCheckout(cwd)) return { available: false, channel: 'git', reason: 'not-a-git-checkout' };
  try {
    const target = await resolveGitTarget({ cwd, remote, branch, gitRunner });
    await gitRunner(['fetch', '--quiet', target.remoteName, target.branch], cwd);
    const local = await gitRunner(['rev-parse', 'HEAD'], cwd);
    const remoteHead = await gitRunner(['rev-parse', 'FETCH_HEAD'], cwd);
    const behind = finiteCount(await gitRunner(['rev-list', '--count', `${local}..${remoteHead}`], cwd));
    const ahead = finiteCount(await gitRunner(['rev-list', '--count', `${remoteHead}..${local}`], cwd));
    const version = await gitRunner(['show', `${remoteHead}:package.json`], cwd)
      .then((text) => String(JSON.parse(text).version || ''))
      .catch(() => '');
    const currentVersion = readPackageMetadata(cwd).version;
    return {
      available: behind > 0,
      channel: 'git',
      commits: behind,
      ahead,
      diverged: behind > 0 && ahead > 0,
      currentVersion,
      version,
      local,
      remote: remoteHead,
      remoteName: target.remoteName,
      branch: target.branch,
      upstream: `${target.remoteName}/${target.branch}`,
    };
  } catch (error) {
    return { available: false, channel: 'git', reason: 'check-failed', error: compactError(error) };
  }
}

export async function checkForNpmUpdate({
  cwd = UPDATE_ROOT,
  packageName,
  currentVersion,
  npmRunner = runNpm,
} = {}) {
  const metadata = readPackageMetadata(cwd);
  const name = packageName || metadata.name;
  const installed = currentVersion || metadata.version;
  try {
    const raw = await npmRunner(['view', name, 'dist-tags', '--json'], cwd);
    const tags = normalizeDistTags(JSON.parse(raw));
    const release = newestRelease(tags);
    if (!release) {
      return {
        available: false,
        channel: 'npm',
        packageName: name,
        currentVersion: installed,
        reason: 'no-dist-tags',
      };
    }
    return {
      available: compareVersions(release.version, installed) > 0,
      channel: 'npm',
      packageName: name,
      currentVersion: installed,
      version: release.version,
      tag: release.tag,
      distTags: tags,
    };
  } catch (error) {
    return {
      available: false,
      channel: 'npm',
      packageName: name,
      currentVersion: installed,
      reason: 'check-failed',
      error: compactError(error),
    };
  }
}

/** Apply a previously checked update, or check first when called directly. */
export async function applyUpdate(options = {}) {
  const check = options.check || await checkForUpdate(options);
  if (check.reason) return { updated: false, ...check };
  if (!check.available) return { updated: false, reason: 'up-to-date', ...check };
  if (check.channel === 'git') return applyGitUpdate({ ...options, check });
  return applyNpmUpdate({ ...options, check });
}

export async function applyGitUpdate({
  cwd = UPDATE_ROOT,
  remote,
  branch,
  check,
  gitRunner = runGit,
  npmRunner = runNpm,
  installDependencies = true,
} = {}) {
  if (!isGitCheckout(cwd)) return { updated: false, channel: 'git', reason: 'not-a-git-checkout' };
  try {
    const dirty = await gitRunner(['status', '--porcelain'], cwd);
    if (dirty.trim()) return { updated: false, channel: 'git', reason: 'dirty-worktree' };
    const target = await resolveGitTarget({
      cwd,
      remote: remote || check?.remoteName,
      branch: branch || check?.branch,
      gitRunner,
    });
    await gitRunner(['pull', '--ff-only', target.remoteName, target.branch], cwd, 30_000);
    const head = await gitRunner(['rev-parse', 'HEAD'], cwd);
    let dependenciesInstalled = false;
    let dependencyWarning = '';
    if (installDependencies) {
      const installArgs = existsSync(resolve(cwd, 'package-lock.json'))
        ? ['ci', '--no-audit', '--no-fund']
        : ['install', '--no-audit', '--no-fund'];
      try {
        await npmRunner(installArgs, cwd, 120_000);
        dependenciesInstalled = true;
      } catch (error) {
        dependencyWarning = compactError(error);
      }
    }
    return {
      updated: true,
      channel: 'git',
      head,
      version: readPackageMetadata(cwd).version,
      remoteName: target.remoteName,
      branch: target.branch,
      dependenciesInstalled,
      ...(dependencyWarning ? { dependencyWarning } : {}),
    };
  } catch (error) {
    return { updated: false, channel: 'git', reason: 'update-failed', error: compactError(error) };
  }
}

export async function applyNpmUpdate({
  cwd = UPDATE_ROOT,
  check,
  packageName,
  currentVersion,
  npmRunner = runNpm,
} = {}) {
  const wanted = check || await checkForNpmUpdate({ cwd, packageName, currentVersion, npmRunner });
  if (wanted.reason) return { updated: false, ...wanted };
  if (!wanted.available) return { updated: false, reason: 'up-to-date', ...wanted };
  try {
    await npmRunner(['install', '--global', `${wanted.packageName}@${wanted.version}`, '--no-audit', '--no-fund'], cwd, 120_000);
    return {
      updated: true,
      channel: 'npm',
      packageName: wanted.packageName,
      previousVersion: wanted.currentVersion,
      version: wanted.version,
      tag: wanted.tag,
    };
  } catch (error) {
    return {
      updated: false,
      channel: 'npm',
      packageName: wanted.packageName,
      version: wanted.version,
      reason: 'update-failed',
      error: compactError(error),
    };
  }
}

/** Standalone `approx update` workflow. */
export async function runUpdateCommand({
  cwd = UPDATE_ROOT,
  write = (text) => process.stdout.write(text),
  gitRunner = runGit,
  npmRunner = runNpm,
} = {}) {
  write('Approx update: checking for the latest version...\n');
  const check = await checkForUpdate({ cwd, gitRunner, npmRunner });
  if (check.reason) {
    write(`Approx update: check failed (${formatUpdateFailure(check)}).\n`);
    return { ok: false, check };
  }
  if (!check.available) {
    write(`Approx is up to date (${check.currentVersion || check.version || 'current'} via ${check.channel}).\n`);
    return { ok: true, check, updated: false };
  }
  const label = check.version || check.remote?.slice(0, 7) || 'new version';
  write(`Approx update: ${label} available via ${check.channel}; installing...\n`);
  const result = await applyUpdate({ cwd, check, gitRunner, npmRunner });
  if (!result.updated) {
    write(`Approx update: stopped (${formatUpdateFailure(result)}).\n`);
    return { ok: false, check, result };
  }
  if (result.dependencyWarning) {
    write(`Approx source updated, but dependency sync needs attention: ${result.dependencyWarning}\n`);
    return { ok: false, check, result };
  }
  write(`Approx ${result.version || label} installed. Restart Approx to load it.\n`);
  return { ok: true, check, result, updated: true };
}

export function formatUpdateFailure(result = {}) {
  if (result.error) return result.error;
  if (result.reason === 'dirty-worktree') return 'commit or stash local changes first';
  if (result.reason === 'not-a-git-checkout') return 'Git checkout not found';
  if (result.reason === 'no-dist-tags') return 'npm registry returned no release tags';
  if (result.reason === 'up-to-date') return 'already up to date';
  return String(result.reason || 'unknown update error');
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return String(left).localeCompare(String(right), undefined, { numeric: true });
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i++) {
    const delta = (a.core[i] || 0) - (b.core[i] || 0);
    if (delta) return Math.sign(delta);
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] == null) return -1;
    if (b.pre[i] == null) return 1;
    const an = /^\d+$/.test(a.pre[i]);
    const bn = /^\d+$/.test(b.pre[i]);
    if (an && bn) {
      const delta = Number(a.pre[i]) - Number(b.pre[i]);
      if (delta) return Math.sign(delta);
    } else if (an !== bn) return an ? -1 : 1;
    else {
      const delta = a.pre[i].localeCompare(b.pre[i]);
      if (delta) return Math.sign(delta);
    }
  }
  return 0;
}

async function resolveGitTarget({ cwd, remote, branch, gitRunner }) {
  if (remote && branch) return { remoteName: remote, branch };
  const upstream = await gitRunner(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd)
    .catch(() => '');
  const split = upstream.indexOf('/');
  return {
    remoteName: remote || (split > 0 ? upstream.slice(0, split) : DEFAULT_REMOTE),
    branch: branch || (split > 0 ? upstream.slice(split + 1) : DEFAULT_BRANCH),
  };
}

function normalizeDistTags(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([tag, version]) => [String(tag), String(version || '')])
    .filter(([, version]) => !!parseVersion(version)));
}

function newestRelease(tags) {
  return Object.entries(tags)
    .map(([tag, version]) => ({ tag, version }))
    .sort((a, b) => compareVersions(b.version, a.version)
      || Number(b.tag === 'latest') - Number(a.tag === 'latest'))[0] || null;
}

function parseVersion(value) {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    core: match[1].split('.').map(Number),
    pre: match[2] ? match[2].split('.') : [],
  };
}

function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

async function runGit(args, cwd, timeout = 12_000) {
  return runFile('git', args, cwd, timeout);
}

async function runNpm(args, cwd, timeout = 30_000) {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (npmCli) return runFile(process.execPath, [npmCli, ...args], cwd, timeout);
  if (process.platform === 'win32') throw new Error('npm-cli.js was not found next to the active Node.js runtime');
  return runFile('npm', args, cwd, timeout);
}

async function runFile(file, args, cwd, timeout) {
  const { stdout } = await execFileAsync(file, args, {
    cwd,
    windowsHide: true,
    timeout,
    maxBuffer: 1024 * 1024,
  });
  return String(stdout ?? '').trim();
}

function compactError(error) {
  return String(error?.stderr || error?.message || error).replace(/\s+/g, ' ').trim().slice(0, 300);
}
