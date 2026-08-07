import { relative } from 'node:path';
import { diffLines, structuredPatch } from 'diff';

const MAX_DIFF_LINES = 900;

/** Merge repeated Write/Edit mutations from one turn into one final file view. */
export function buildFileChanges(mutations, cwd = process.cwd()) {
  const merged = new Map();
  for (const mutation of mutations ?? []) {
    if (!mutation?.path || !mutation.before || !mutation.after) continue;
    const path = String(mutation.path);
    const prior = merged.get(path);
    if (prior) prior.after = mutation.after;
    else merged.set(path, { path, before: mutation.before, after: mutation.after });
  }

  const files = [];
  for (const item of merged.values()) {
    if (sameSnapshot(item.before, item.after)) continue;
    const before = decodeSnapshot(item.before);
    const after = decodeSnapshot(item.after);
    const kind = !item.before.exists ? 'added' : !item.after.exists ? 'deleted' : 'modified';
    const displayPath = displayFilePath(cwd, item.path);
    if (before.binary || after.binary) {
      files.push({ path: item.path, displayPath, kind, added: 0, removed: 0, binary: true, diff: [] });
      continue;
    }
    const stats = lineStats(before.text, after.text);
    files.push({
      path: item.path,
      displayPath,
      kind,
      ...stats,
      binary: false,
      diff: contentDiff(displayPath, before.text, after.text),
    });
  }
  return files;
}

export function summarizeFileChanges(files) {
  return (files ?? []).reduce((summary, file) => ({
    files: summary.files + 1,
    added: summary.added + (file.added ?? 0),
    removed: summary.removed + (file.removed ?? 0),
  }), { files: 0, added: 0, removed: 0 });
}

export function contentDiff(path, before, after) {
  const patch = structuredPatch(path, path, before, after, '', '', { context: 3 });
  const lines = [];
  for (const hunk of patch.hunks) {
    lines.push({
      kind: 'hunk',
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldLine: null,
      newLine: null,
    });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      const prefix = raw[0];
      if (prefix === '+') {
        lines.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine: newLine++ });
      } else if (prefix === '-') {
        lines.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++, newLine: null });
      } else if (prefix === ' ') {
        lines.push({ kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
      } else {
        lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null });
      }
      if (lines.length >= MAX_DIFF_LINES) {
        lines.push({ kind: 'meta', text: `... diff clipped at ${MAX_DIFF_LINES} rows`, oldLine: null, newLine: null });
        return lines;
      }
    }
  }
  return lines;
}

/** Parse ordinary `git diff` output into numbered render rows. */
export function parseUnifiedDiff(text) {
  const lines = [];
  let oldLine = null;
  let newLine = null;
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: 'hunk', text: raw, oldLine: null, newLine: null });
    } else if (oldLine != null && raw.startsWith('+') && !raw.startsWith('+++')) {
      lines.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine: newLine++ });
    } else if (oldLine != null && raw.startsWith('-') && !raw.startsWith('---')) {
      lines.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++, newLine: null });
    } else if (oldLine != null && raw.startsWith(' ')) {
      lines.push({ kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else if (raw) {
      lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null });
    }
    if (lines.length >= MAX_DIFF_LINES) {
      lines.push({ kind: 'meta', text: `... diff clipped at ${MAX_DIFF_LINES} rows`, oldLine: null, newLine: null });
      break;
    }
  }
  return lines;
}

function lineStats(before, after) {
  let added = 0;
  let removed = 0;
  for (const change of diffLines(before, after)) {
    if (change.added) added += change.count ?? countLines(change.value);
    if (change.removed) removed += change.count ?? countLines(change.value);
  }
  return { added, removed };
}

function decodeSnapshot(snapshot) {
  if (!snapshot?.exists) return { text: '', binary: false };
  const data = Buffer.from(String(snapshot.data ?? ''), 'base64');
  return { text: data.toString('utf8'), binary: data.includes(0) };
}

function sameSnapshot(left, right) {
  return !!left && !!right && left.exists === right.exists && left.data === right.data;
}

function displayFilePath(cwd, path) {
  const local = relative(String(cwd || process.cwd()), path);
  const shown = local && !local.startsWith('..') ? local : path;
  return String(shown).replace(/\\/g, '/');
}

function countLines(value) {
  if (!value) return 0;
  return String(value).split('\n').length - (String(value).endsWith('\n') ? 1 : 0);
}
