// Inline @path completion. References stay as text; Pi reads them lazily when needed.

import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { clamp } from './anim.js';
import { inputLength, setComposerInput } from './composer-state.js';
import { readDirectoryEntries, resolveDirectory } from './directories.js';
import { fuzzy } from './ui/palette.js';

const PATH_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const tokenBoundary = (ch) => ch == null || /\s/u.test(ch) || !/[\p{L}\p{N}_.\/\-]/u.test(ch);
const normalizePath = (value) => String(value ?? '').replace(/\\/g, '/');

export function createFileMentionState() {
  return {
    matches: [],
    index: 0,
    scroll: 0,
    loading: false,
    requestId: 0,
    context: null,
    dismissed: '',
  };
}

/** Locate the @ token that owns the composer caret. Offsets are Unicode code points. */
export function activeFileMention(value, cursor = Infinity) {
  const chars = [...String(value ?? '')];
  const at = clamp(Number.isFinite(cursor) ? cursor : chars.length, 0, chars.length);
  let start = -1;
  let quoted = false;

  for (let i = at - 1; i >= 0; i--) {
    const ch = chars[i];
    if (ch === '\n' || ch === '\r') break;
    if (ch === '"') {
      if (chars[i - 1] === '@' && tokenBoundary(chars[i - 2])) {
        start = i - 1;
        quoted = true;
      }
      break;
    }
    if (ch !== '@' || !tokenBoundary(chars[i - 1])) continue;
    quoted = chars[i + 1] === '"';
    if (!quoted && chars.slice(i + 1, at).some(tokenBoundary)) break;
    start = i;
    break;
  }
  if (start < 0) return null;

  let end = at;
  if (quoted) {
    while (end < chars.length && chars[end] !== '"') end++;
    if (chars[end] === '"') end++;
  } else {
    while (end < chars.length && !tokenBoundary(chars[end])) end++;
  }
  const contentStart = start + (quoted ? 2 : 1);
  const raw = normalizePath(chars.slice(contentStart, at).join(''));
  return {
    start, end, cursor: at, raw, quoted,
    signature: `${start}:${at}:${quoted ? 'q' : 'u'}:${raw}`,
  };
}

function inputPath(cwd, target, directory) {
  const base = resolve(String(cwd || process.cwd()));
  let value = relative(base, target);
  if (!value && directory) return '';
  if (isAbsolute(value)) value = target;
  value = normalizePath(value);
  return directory && value && !value.endsWith('/') ? `${value}/` : value;
}

function mentionToken(path, quoted = false) {
  if (!path) return '@';
  const needsQuotes = quoted || /\s/u.test(path);
  return needsQuotes ? `@"${path}"` : `@${path}`;
}

/** Pi searches the project tree for a typed @query; cap the local fallback work. */
async function fuzzyTreeEntries(folder, query, limit = 240) {
  const pending = [folder];
  const matches = [];
  while (pending.length && matches.length < limit) {
    const current = pending.shift();
    // Bare @queries are a project-source search, not a dependency crawler.
    // Linked directories are still available when the user enters them
    // explicitly, but following them here can leave the workspace or form a
    // cycle (for example, a junction back to the project root).
    const entries = await readDirectoryEntries(current, {
      includeFiles: true,
      excludeNames: ['.git', 'node_modules'],
    });
    for (const entry of entries) {
      const target = join(current, entry.name);
      if (entry.kind === 'directory' && !entry.linked) pending.push(target);
      const match = fuzzy(query, entry.name) ?? fuzzy(query, inputPath(folder, target, entry.kind === 'directory'));
      if (!match) continue;
      matches.push({
        name: inputPath(folder, target, entry.kind === 'directory'),
        desc: entry.kind === 'directory' ? 'FOLDER' : 'FILE',
        kind: entry.kind,
        target,
        linked: entry.linked,
        score: match.score + (entry.name.toLowerCase().startsWith(query.toLowerCase()) ? 20 : 0),
      });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

function replaceMention(st, context, token, directory) {
  const chars = [...String(st.input ?? '')];
  const before = chars.slice(0, context.start).join('');
  let after = chars.slice(context.end).join('');
  let suffix = '';
  if (!directory && !/^\s/u.test(after)) suffix = ' ';
  if (!directory && /^\s/u.test(after)) after = after.replace(/^\s+/u, ' ');
  const next = `${before}${token}${suffix}${after}`;
  const quotedDirectory = directory && token.endsWith('"');
  const cursor = inputLength(before) + inputLength(token) - (quotedDirectory ? 1 : 0) + inputLength(suffix);
  setComposerInput(st, next, cursor);
}

export async function fileMentionMatches(value, cursor, cwd) {
  const context = activeFileMention(value, cursor);
  if (!context) return { context: null, matches: [] };
  const slash = Math.max(context.raw.lastIndexOf('/'), context.raw.lastIndexOf('\\'));
  const folderText = slash >= 0 ? context.raw.slice(0, slash + 1) : '';
  const query = slash >= 0 ? context.raw.slice(slash + 1) : context.raw;
  const folder = await resolveDirectory(folderText || '.', cwd);
  const entries = query
    ? await fuzzyTreeEntries(folder, query)
    : await readDirectoryEntries(folder, { includeFiles: true, excludeNames: ['.git'] });
  const parent = dirname(folder);
  const matches = [];

  if (parent !== folder) {
    matches.push({
      name: '..', desc: 'PARENT FOLDER', kind: 'parent', target: parent,
    });
  }
  const scored = [];
  for (const entry of entries) {
    if (query) {
      scored.push(entry);
      continue;
    }
    scored.push({
      name: entry.kind === 'directory' ? `${entry.name}/` : entry.name,
      desc: entry.kind === 'directory' ? 'FOLDER' : 'FILE',
      kind: entry.kind,
      target: join(folder, entry.name),
      linked: entry.linked,
      score: 0,
    });
  }
  scored.sort((a, b) => b.score - a.score
    || (a.kind === b.kind ? PATH_COLLATOR.compare(a.name, b.name) : a.kind === 'directory' ? -1 : 1));
  matches.push(...scored);
  return { context: { ...context, folder, query }, matches };
}

export const fileMentionMethods = {
  fileMentionOpen() {
    return !!this.st.fileMention?.context && this.st.fileMention.matches.length > 0;
  },

  syncComposerSuggestionAnimation() {
    const open = this.slashOpen?.() || this.fileMentionOpen();
    this.st.slashAnim.set(open ? 1 : 0);
  },

  closeFileMention({ dismiss = false } = {}) {
    const mention = this.st.fileMention;
    if (!mention) return;
    if (dismiss && mention.context) mention.dismissed = mention.context.signature;
    mention.requestId++;
    mention.matches = [];
    mention.index = 0;
    mention.scroll = 0;
    mention.loading = false;
    mention.context = null;
    this.syncComposerSuggestionAnimation();
  },

  async refreshFileMention() {
    const mention = this.st.fileMention;
    const context = activeFileMention(this.st.input, this.st.inputCursor);
    if (!context || context.signature === mention.dismissed) {
      this.closeFileMention();
      return [];
    }
    mention.dismissed = '';
    const requestId = ++mention.requestId;
    mention.loading = true;
    mention.context = context;
    this.requestFrame?.();
    try {
      const cwd = this.st.cwdPath || this.backend?.cwd || process.cwd();
      const result = await fileMentionMatches(this.st.input, this.st.inputCursor, cwd);
      const current = activeFileMention(this.st.input, this.st.inputCursor);
      if (requestId !== mention.requestId || current?.signature !== context.signature) return [];
      mention.context = result.context;
      mention.matches = result.matches;
      mention.index = 0;
      mention.scroll = 0;
      this.syncComposerSuggestionAnimation();
      return result.matches;
    } catch {
      if (requestId === mention.requestId) this.closeFileMention();
      return [];
    } finally {
      if (requestId === mention.requestId) {
        mention.loading = false;
        this.requestFrame?.();
      }
    }
  },

  moveFileMention(delta, rows = 5) {
    const mention = this.st.fileMention;
    const count = mention.matches.length;
    if (!count) return;
    mention.index = (mention.index + delta % count + count) % count;
    if (mention.index < mention.scroll) mention.scroll = mention.index;
    if (mention.index >= mention.scroll + rows) mention.scroll = mention.index - rows + 1;
    mention.scroll = clamp(mention.scroll, 0, Math.max(0, count - rows));
    this.st.slashAnim.set(1);
  },

  acceptFileMention() {
    const mention = this.st.fileMention;
    const item = mention.matches[mention.index];
    const context = activeFileMention(this.st.input, this.st.inputCursor);
    if (!item || !context) return null;
    const directory = item.kind !== 'file';
    const cwd = this.st.cwdPath || this.backend?.cwd || process.cwd();
    const path = inputPath(cwd, item.target, directory);
    replaceMention(this.st, context, mentionToken(path, context.quoted), directory);
    if (directory) {
      mention.dismissed = '';
      return this.refreshFileMention();
    }
    this.closeFileMention();
    return item;
  },
};
