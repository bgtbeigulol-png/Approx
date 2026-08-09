import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createPlanState, hydratePlanState } from '../../plan.js';
import { contentDiff, parseUnifiedDiff } from '../../file-changes.js';

export function restorePlanState(branch, fallback = createPlanState()) {
  for (let index = (branch?.length ?? 0) - 1; index >= 0; index--) {
    const entry = branch[index];
    const message = entry?.message;
    const details = message?.details ?? entry?.details ?? entry?.data;
    const snapshot = details?.plan ?? details?.state?.plan ?? details?.state;
    if (snapshot && typeof snapshot === 'object' && ('mode' in snapshot || 'todos' in snapshot)) {
      return hydratePlanState(snapshot, fallback);
    }
  }
  return hydratePlanState(fallback);
}

export function shouldAutoPlan(text, plan) {
  if (plan?.mode === 'plan' || plan?.todos?.length) return false;
  const value = String(text ?? '').trim();
  if (value.length >= 900) return true;
  const signals = [
    /\b(?:architecture|redesign|migration|migrate|large[- ]scale|multi[- ]step|roadmap)\b/i,
    /\b(?:implement|build|refactor|design)\b[\s\S]{0,160}\b(?:system|application|workflow|platform)\b/i,
    /(?:大型|复杂|完整|整体|架构|重构|迁移|方案|多步骤|全流程)/,
  ];
  return value.length >= 280 && signals.some((pattern) => pattern.test(value));
}

export function mutationPath(cwd, args) {
  if (!args || typeof args !== 'object') return null;
  const raw = args.path ?? args.file_path ?? args.filePath;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

export function fileSnapshot(path) {
  if (!existsSync(path)) return { exists: false, data: '' };
  return { exists: true, data: readFileSync(path).toString('base64') };
}

export function captureMutation(cwd, name, args) {
  const kind = String(name ?? '').toLowerCase();
  if (kind !== 'write' && kind !== 'edit') return null;
  const path = mutationPath(cwd, args);
  if (!path) return null;
  try {
    return { kind, path, before: fileSnapshot(path), after: null };
  } catch {
    return null;
  }
}

export function mergeMutations(primary, extra) {
  const seen = new Set();
  const out = [];
  for (const mutation of [...primary, ...extra]) {
    if (!mutation) continue;
    const key = `${mutation.kind}\0${mutation.path}\0${mutation.before?.data ?? ''}\0${mutation.after?.data ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mutation);
  }
  return out;
}

export function finishMutation(mutation) {
  if (!mutation) return null;
  try {
    const after = fileSnapshot(mutation.path);
    if (after.exists === mutation.before.exists && after.data === mutation.before.data) return null;
    return { ...mutation, after };
  } catch {
    return null;
  }
}

export function restoreSnapshot(path, snapshot) {
  if (snapshot?.exists) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(snapshot.data, 'base64'));
  } else if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

export function restoreMutations(mutations, side) {
  const ordered = side === 'before' ? [...mutations].reverse() : [...mutations];
  for (const mutation of ordered) {
    if (!mutation?.path || !mutation?.[side]) continue;
    restoreSnapshot(mutation.path, mutation[side]);
  }
}

// Union the captured full catalog (which includes disabled entries) with the
// live filtered list, preferring live descriptions. Keeps disabled items
// visible in the sidebar while staying accurate about what exists.
export function mergeCatalog(full = [], live = []) {
  const byName = new Map();
  for (const item of full) byName.set(item.name, { name: item.name, description: item.description ?? '' });
  for (const item of live) byName.set(item.name, { name: item.name, description: item.description ?? '' });
  return [...byName.values()];
}

export function normalizeModel(model) {
  if (!model) return null;
  return {
    provider: String(model.provider),
    id: String(model.id),
    label: String(model.id || model.name || `${model.provider}/model`),
    name: String(model.name || model.id),
    contextWindow: Number(model.contextWindow) || 0,
  };
}

export function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

export function messageText(message) {
  return contentText(message?.content);
}

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** Rehydrate the visible branch without injecting any extra messages into context. */
export function sessionTranscript(entries, cwd = process.cwd()) {
  const visible = [];
  const calls = new Map();
  const persistedChanges = new Map();
  let pendingTitles = [];
  let pendingGroup = '';
  for (const entry of entries ?? []) {
    if (entry?.type === 'custom' && entry.customType === 'approx-file-changes') {
      const id = String(entry.data?.callId ?? '');
      const changes = normalizePersistedFileChanges(entry.data?.fileChanges);
      if (id && changes.length) {
        persistedChanges.set(id, changes);
        const tool = calls.get(id);
        if (tool) tool.fileChanges = changes;
      }
      continue;
    }
    if (entry?.type !== 'message') continue;
    const message = entry.message ?? {};
    const time = shortTime(entry.timestamp);
    if (message.role === 'user') {
      const text = messageText(message);
      if (text) visible.push({ role: 'user', text, entryId: entry.id, time });
      continue;
    }
    if (message.role === 'assistant') {
      const parts = Array.isArray(message.content) ? message.content : [];
      const toolCalls = parts.filter((part) => part?.type === 'toolCall');
      const raw = messageText(message);
      const namingTurn = toolCalls.length > 0 || message.stopReason === 'toolUse';
      const parsedTitles = namingTurn ? modelToolTitles(raw) : [];
      const availableTitles = [...pendingTitles, ...unconsumedTitles(parsedTitles, [], pendingTitles)];
      const groupTitle = namingTurn ? (modelToolGroupTitle(raw) || pendingGroup) : '';
      const headings = [
        ...availableTitles,
        ...(groupTitle ? [`Tool Calls: ${groupTitle}`] : []),
      ];
      const text = namingTurn ? stripToolTitleHeadings(raw, headings) : raw;
      if (text) visible.push({ role: 'approx', text, time, stopReason: String(message.stopReason ?? '') });
      if (!toolCalls.length && namingTurn) {
        pendingTitles = availableTitles;
        if (groupTitle) pendingGroup = groupTitle;
      }
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const fallbackTitle = toolTitle(call.name, call.arguments);
        const title = availableTitles[i] || '';
        const tool = {
          role: 'tool',
          callId: String(call.id ?? `historic-tool-${visible.length}`),
          name: String(call.name ?? 'tool'),
          title: title || fallbackTitle,
          fallbackTitle,
          modelTitle: !!title,
          groupTitle: i === 0 ? groupTitle : '',
          modelGroupTitle: i === 0 && !!groupTitle,
          meta: summarizeArgs(call.arguments),
          args: call.arguments,
          text: '',
          running: false,
          expanded: false,
          time,
        };
        visible.push(tool);
        calls.set(tool.callId, tool);
        if (persistedChanges.has(tool.callId)) tool.fileChanges = persistedChanges.get(tool.callId);
      }
      if (toolCalls.length) {
        pendingTitles = [];
        pendingGroup = '';
      }
      continue;
    }
    if (message.role === 'toolResult') {
      const id = String(message.toolCallId ?? '');
      let tool = calls.get(id);
      if (!tool) {
        const name = String(message.toolName ?? 'tool');
        const fallbackTitle = toolTitle(name, {});
        tool = {
          role: 'tool', callId: id || `historic-tool-${visible.length}`, name,
          title: fallbackTitle, fallbackTitle, text: '', running: false, expanded: false, time,
        };
        visible.push(tool);
        calls.set(tool.callId, tool);
      }
      tool.text = contentText(message.content);
      tool.isError = !!message.isError;
      tool.meta = tool.isError ? 'error' : (tool.meta || 'done');
      if (!tool.isError && !tool.fileChanges?.length) {
        tool.fileChanges = historicToolFileChanges(cwd, tool, message);
      }
    }
  }
  return visible;
}

function historicToolFileChanges(cwd, tool, result) {
  const name = String(tool?.name ?? '').toLowerCase();
  if (!['write', 'edit', 'apply_patch'].includes(name)) return [];
  const patch = typeof result?.details?.patch === 'string' ? result.details.patch : '';
  const path = mutationPath(cwd, tool.args) ?? patchFilePath(cwd, patch);
  if (!path) return [];

  if (patch) {
    const diff = parseUnifiedDiff(patch).filter((line) => line.kind !== 'meta'
      || (!line.text.startsWith('--- ') && !line.text.startsWith('+++ ')));
    const oldHeader = patch.split(/\r?\n/).find((line) => line.startsWith('--- ')) ?? '';
    const newHeader = patch.split(/\r?\n/).find((line) => line.startsWith('+++ ')) ?? '';
    return [{
      path,
      kind: oldHeader.includes('/dev/null') ? 'added' : newHeader.includes('/dev/null') ? 'deleted' : 'modified',
      added: diff.filter((line) => line.kind === 'add').length,
      removed: diff.filter((line) => line.kind === 'del').length,
      binary: false,
      diff,
    }];
  }

  if (name === 'write' && typeof tool.args?.content === 'string') {
    const diff = contentDiff(path, '', tool.args.content);
    return [{
      path,
      kind: 'added',
      added: diff.filter((line) => line.kind === 'add').length,
      removed: 0,
      binary: false,
      diff,
    }];
  }
  return [];
}

function patchFilePath(cwd, patch) {
  const header = String(patch).split(/\r?\n/)
    .find((line) => line.startsWith('+++ ') && !line.includes('/dev/null'))
    ?? String(patch).split(/\r?\n/).find((line) => line.startsWith('--- ') && !line.includes('/dev/null'));
  if (!header) return null;
  const raw = header.slice(4).split('\t')[0].trim();
  if (!raw) return null;
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw.replace(/^[ab]\//, ''));
}

function normalizePersistedFileChanges(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item?.path && Array.isArray(item.diff)).map((item) => ({
    path: String(item.path),
    kind: String(item.kind ?? 'modified'),
    added: Math.max(0, Number(item.added) || 0),
    removed: Math.max(0, Number(item.removed) || 0),
    binary: !!item.binary,
    diff: item.diff.map((line) => ({
      kind: String(line?.kind ?? 'meta'),
      text: String(line?.text ?? ''),
      oldLine: Number.isFinite(line?.oldLine) ? line.oldLine : null,
      newLine: Number.isFinite(line?.newLine) ? line.newLine : null,
    })),
  }));
}

export function summarizeArgs(args) {
  if (args == null) return '';
  let text;
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args);
  } catch {
    text = String(args);
  }
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function shortTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function relativeDate(value) {
  const diff = Math.max(0, Date.now() - value.getTime());
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return `${value.getMonth() + 1}/${value.getDate()}`;
}

export function modelToolTitles(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const titles = [];
  for (const line of lines) {
    const match = /^(?:#{1,4}\s+|tool\s*:\s*)(.+)$/i.exec(line);
    if (!match) continue;
    const title = match[1].replace(/[*_`#]/g, '').trim();
    if (/^tool calls?\s*[:—-]/i.test(title)) continue;
    if (title && title.length <= 96) titles.push(title);
  }
  return titles;
}

export function unconsumedTitles(incoming, consumed, queued) {
  const counts = new Map();
  for (const title of [...consumed, ...queued]) {
    const key = String(title).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = [];
  for (const title of incoming) {
    const key = String(title).toLowerCase();
    const n = counts.get(key) ?? 0;
    if (n > 0) {
      counts.set(key, n - 1);
    } else {
      out.push(title);
    }
  }
  return out;
}

export function modelToolGroupTitle(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const heading = /^#{1,4}\s+(.+)$/.exec(lines[i]);
    if (!heading) continue;
    const clean = heading[1].replace(/[*_`#]/g, '').trim();
    const match = /^tool calls?\s*[:—-]\s*(.+)$/i.exec(clean);
    const title = match?.[1]?.trim();
    if (title && title.length <= 96) return title;
  }
  return '';
}

export function toolTitle(name, args) {
  const tool = String(name ?? 'tool').toLowerCase();
  const input = args && typeof args === 'object' ? args : {};
  const path = String(input.path ?? input.file_path ?? input.filePath ?? '').replace(/\\/g, '/');
  const file = path.split('/').filter(Boolean).at(-1);
  if (tool === 'read') return file ? `Read ${file}` : 'Read files';
  if (tool === 'write') return file ? `Write ${file}` : 'Write file';
  if (tool === 'edit') return file ? `Edit ${file}` : 'Edit file';
  if (tool === 'grep') return `Search ${clip(input.pattern ?? input.query ?? 'project', 44)}`;
  if (tool === 'find' || tool === 'ls') return path ? `Inspect ${file || path}` : 'Inspect project';
  if (tool === 'bash' || tool === 'shell' || tool === 'shell_command') {
    return shellToolTitle(input.command ?? input.cmd ?? input.script ?? 'command');
  }
  return `${tool.replace(/[_-]+/g, ' ')} call`;
}

export function shellToolTitle(value) {
  const raw = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  const command = raw
    .replace(/^\s*(?:cd|Set-Location)\s+(?:"[^"]*"|'[^']*'|[^;&]+?)\s*(?:&&|;)\s*/i, '')
    .trim();
  const lower = command.toLowerCase();
  if ((/\bfind\b/.test(lower) && /(?:-type\s+f|-file\b)/.test(lower)) || /\bget-childitem\b/.test(lower)) {
    return 'List project files';
  }
  if (/\bwc\s+-l\b/.test(lower) || /measure-object\s+-line\b/.test(lower)) return 'Count project lines';
  if (/\b(?:npm|pnpm|yarn)\b[^;&]*(?:smoke|test)\b/.test(lower) || /scripts[\\/]smoke\b/.test(lower)) {
    return 'Run smoke tests';
  }
  if (/scripts[\\/]bench\b|\bbenchmark\b/.test(lower)) return 'Benchmark renderer';
  if (/\bgit\s+status\b/.test(lower)) return 'Check Git status';
  if (/\bgit\s+diff\b/.test(lower)) return 'Inspect Git changes';
  if (/\b(?:rg|grep|select-string)\b/.test(lower)) return 'Search project text';
  if (/\b(?:curl|invoke-webrequest|wget)\b/.test(lower)) return 'Fetch remote data';
  if (/^echo\b/i.test(command)) return `Print ${clip(command.slice(4).replace(/["']/g, '').trim() || 'message', 40)}`;
  const first = command.split(/\s*(?:&&|;)\s*/)[0] || raw || 'command';
  return `Run ${clip(first, 52)}`;
}

export function stripToolTitleHeadings(text, titles) {
  if (!titles?.length) return text;
  const pending = new Set(titles.map((title) => title.trim().toLowerCase()));
  return String(text ?? '')
    .split('\n')
    .filter((line) => {
      const match = /^\s*#{1,4}\s+(.+?)\s*$/.exec(line);
      if (!match) return true;
      const title = match[1].replace(/[*_`#]/g, '').trim().toLowerCase();
      if (!pending.has(title)) return true;
      pending.delete(title);
      return false;
    })
    .join('\n')
    .replace(/^\s+|\s+$/g, '');
}

export function clip(value, n) {
  const text = String(value ?? '').trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

export function formatError(error) {
  return String(error?.message ?? error ?? 'Unknown Approx error');
}

export function isAbortError(error) {
  const text = formatError(error).toLowerCase();
  return error?.name === 'AbortError' || text.includes('abort') || text.includes('interrupt');
}
