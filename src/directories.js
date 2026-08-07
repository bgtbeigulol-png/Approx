// Async project-directory browser and workspace switching controller.

import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Spring, clamp } from './anim.js';
import { samePath as sameDirectory } from './path-utils.js';
import { DIRECTORY_ROWS, directoryHit, directoryLayout } from './ui/directories.js';

export { sameDirectory };

const DIRECTORY_SPRING = { stiff: 18, damp: 0.88 };
const CURSOR_SPRING = { stiff: 22, damp: 0.9 };
const PATH_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function formatWorkingDirectory(path) {
  const value = String(path ?? '').replace(/\\/g, '/');
  const parts = value.split('/').filter(Boolean);
  return parts.length <= 2 ? value : `\u2026/${parts.slice(-2).join('/')}`;
}

/** Resolve aliases and relative paths, then prove that the result is a directory. */
export async function resolveDirectory(input, base = process.cwd()) {
  let raw = String(input ?? '').trim();
  if (raw.length >= 2 && ((raw[0] === '"' && raw.at(-1) === '"')
    || (raw[0] === "'" && raw.at(-1) === "'"))) raw = raw.slice(1, -1);
  if (!raw) raw = String(base || process.cwd());
  if (raw === '~') raw = homedir();
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) raw = join(homedir(), raw.slice(2));

  const candidate = isAbsolute(raw) ? raw : resolve(String(base || process.cwd()), raw);
  const canonical = await realpath(candidate);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${candidate}`);
  return canonical;
}

export function createDirectoryPickerState(initialPath = process.cwd()) {
  return {
    open: false,
    loading: false,
    switching: false,
    editingPath: false,
    replacePathInput: false,
    path: resolve(String(initialPath || process.cwd())),
    pathInput: '',
    items: [],
    index: 0,
    scroll: 0,
    error: '',
    requestId: 0,
    anim: new Spring(0, DIRECTORY_SPRING),
    cursor: new Spring(0, CURSOR_SPRING),
    travel: new Spring(0, { stiff: 20, damp: 0.82 }),
    pulse: new Spring(0, { stiff: 14, damp: 0.78 }),
  };
}

async function directoryChildren(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) return { name: entry.name, linked: false };
    if (!entry.isSymbolicLink()) return null;
    try {
      return (await stat(join(path, entry.name))).isDirectory()
        ? { name: entry.name, linked: true }
        : null;
    } catch {
      return null;
    }
  }));
  return children.filter(Boolean).sort((a, b) => PATH_COLLATOR.compare(a.name, b.name));
}

function pickerItems(path, children) {
  const parent = dirname(path);
  return [
    { kind: 'select', label: 'SELECT THIS FOLDER', path },
    ...(sameDirectory(parent, path) ? [] : [{ kind: 'parent', label: '..', path: parent }]),
    ...children.map((item) => ({
      kind: 'directory',
      label: item.name,
      path: join(path, item.name),
      linked: item.linked,
    })),
  ];
}

function pickerState(app) {
  if (!app.st.directoryPicker) {
    app.st.directoryPicker = createDirectoryPickerState(app.st.cwdPath || app.backend?.cwd || process.cwd());
  }
  return app.st.directoryPicker;
}

export const directoryMethods = {
  commandCd(arg = '') {
    const path = String(arg ?? '').trim();
    if (!path) return this.openDirectoryPicker();
    void this.switchDirectory(path);
  },

  openDirectoryPicker() {
    const picker = pickerState(this);
    if (this.st.palette) this.closePalette?.();
    if (this.st.jump) this.closeJump?.();
    if (this.st.view === 'settings') this.closeSettings?.();
    if (this.st.sessionPicker?.open) this.closeSessions?.();
    picker.open = true;
    picker.error = '';
    picker.editingPath = false;
    picker.anim.set(1, !!this.st.reduceMotion);
    picker.pulse.set(1, true);
    picker.pulse.set(0);
    const start = this.st.cwdPath || this.backend?.cwd || picker.path || process.cwd();
    void this.loadDirectory(start, 0);
  },

  closeDirectoryPicker() {
    const picker = pickerState(this);
    if (picker.switching) return;
    picker.open = false;
    picker.editingPath = false;
    picker.anim.set(0, !!this.st.reduceMotion);
    this.s?.invalidate();
  },

  async loadDirectory(path, direction = 1) {
    const picker = pickerState(this);
    const requestId = ++picker.requestId;
    const previousPath = picker.path || this.st.cwdPath || process.cwd();
    picker.loading = true;
    picker.error = '';
    picker.pulse.set(1, true);
    picker.pulse.set(0);
    this.s?.invalidate();
    try {
      const canonical = await resolveDirectory(path, previousPath);
      const children = await directoryChildren(canonical);
      if (requestId !== picker.requestId || !picker.open) return null;
      picker.path = canonical;
      picker.pathInput = canonical;
      picker.items = pickerItems(canonical, children);
      picker.index = 0;
      picker.scroll = 0;
      picker.cursor.set(0, true);
      if (direction) {
        picker.travel.set(clamp(direction, -1, 1), true);
        picker.travel.set(0, !!this.st.reduceMotion);
      }
      return canonical;
    } catch (error) {
      if (requestId !== picker.requestId || !picker.open) return null;
      picker.error = String(error?.message ?? error);
      this.toast?.('folder could not be opened', 'warn');
      return null;
    } finally {
      if (requestId === picker.requestId) {
        picker.loading = false;
        this.s?.invalidate();
      }
    }
  },

  directoryRows() {
    const picker = pickerState(this);
    return directoryLayout(this.s.w, this.s.h, picker.items.length, picker.anim.v).rows;
  },

  clampDirectoryScroll() {
    const picker = pickerState(this);
    const rows = this.directoryRows();
    if (picker.index < picker.scroll) picker.scroll = picker.index;
    if (picker.index >= picker.scroll + rows) picker.scroll = picker.index - rows + 1;
    picker.scroll = clamp(picker.scroll, 0, Math.max(0, picker.items.length - rows));
  },

  selectDirectoryIndex(index) {
    const picker = pickerState(this);
    if (!picker.items.length) return;
    picker.index = clamp(index, 0, picker.items.length - 1);
    picker.cursor.set(picker.index, !!this.st.reduceMotion);
    this.clampDirectoryScroll();
  },

  moveDirectory(d) {
    const picker = pickerState(this);
    const count = picker.items.length;
    if (!count || picker.loading || picker.switching) return;
    this.selectDirectoryIndex((picker.index + d % count + count) % count);
  },

  activateDirectoryItem(item = pickerState(this).items[pickerState(this).index]) {
    if (!item) return;
    if (item.kind === 'select') return void this.switchDirectory(item.path);
    void this.loadDirectory(item.path, item.kind === 'parent' ? -1 : 1);
  },

  editDirectoryPath() {
    const picker = pickerState(this);
    if (picker.switching) return;
    picker.editingPath = true;
    picker.pathInput = picker.path;
    picker.replacePathInput = true;
    picker.error = '';
    picker.pulse.set(1, true);
    picker.pulse.set(0);
  },

  directoryPathKey(k) {
    const picker = pickerState(this);
    if (k.name === 'escape' || (k.ctrl && k.name === 'l')) {
      picker.editingPath = false;
      picker.pathInput = picker.path;
      return;
    }
    if (k.name === 'enter') {
      const value = picker.pathInput;
      picker.editingPath = false;
      void this.loadDirectory(value, 1);
      return;
    }
    if (k.ctrl && k.name === 'a') {
      picker.replacePathInput = true;
      return;
    }
    if (k.name === 'backspace') {
      if (picker.replacePathInput) picker.pathInput = '';
      else picker.pathInput = [...picker.pathInput].slice(0, -1).join('');
      picker.replacePathInput = false;
      return;
    }
    if (k.name === 'space') {
      if (picker.replacePathInput) picker.pathInput = '';
      picker.pathInput += ' ';
      picker.replacePathInput = false;
      return;
    }
    if (k.printable && !k.ctrl && !k.alt) {
      if (picker.replacePathInput) picker.pathInput = '';
      picker.pathInput += k.name;
      picker.replacePathInput = false;
    }
  },

  directoryPointer(x, y, activate = false) {
    const picker = pickerState(this);
    const g = directoryLayout(this.s.w, this.s.h, picker.items.length, picker.anim.v);
    const inside = x >= g.px && x < g.px + g.pw && y >= g.py && y < g.py + g.ph;
    if (!inside) {
      if (activate) this.closeDirectoryPicker();
      return;
    }
    if (y === g.pathY && x > g.px && x < g.px + g.pw - 1) {
      if (activate) this.editDirectoryPath();
      return;
    }
    const index = directoryHit(g, x, y, picker.scroll, picker.items.length);
    if (index < 0) return;
    this.selectDirectoryIndex(index);
    if (activate) this.activateDirectoryItem(picker.items[index]);
  },

  directoryKey(k) {
    const picker = pickerState(this);
    if (picker.editingPath) return this.directoryPathKey(k);
    if (k.name === 'escape') return this.closeDirectoryPicker();
    if (k.ctrl && k.name === 'l') return this.editDirectoryPath();
    if (k.name === 'mousemove' && k.mouse) return this.directoryPointer(k.x, k.y, false);
    if (k.name === 'mousedown' && k.mouse) return this.directoryPointer(k.x, k.y, true);
    if (k.name === 'wheelup') return this.moveDirectory(-3);
    if (k.name === 'wheeldown') return this.moveDirectory(3);
    if (k.name === 'up' || (k.ctrl && k.name === 'k')) return this.moveDirectory(-1);
    if (k.name === 'down' || (k.ctrl && k.name === 'n')) return this.moveDirectory(1);
    if (k.name === 'pageup') return this.moveDirectory(-this.directoryRows());
    if (k.name === 'pagedown') return this.moveDirectory(this.directoryRows());
    if (k.name === 'home') return this.selectDirectoryIndex(0);
    if (k.name === 'end') return this.selectDirectoryIndex(picker.items.length - 1);
    if (k.name === 'left' || k.name === 'backspace') {
      const parent = picker.items.find((item) => item.kind === 'parent');
      if (parent) void this.loadDirectory(parent.path, -1);
      return;
    }
    if (k.ctrl && k.name === 'enter') return void this.switchDirectory(picker.path);
    if (k.name === 'right') {
      const item = picker.items[picker.index];
      if (item?.kind !== 'select') this.activateDirectoryItem(item);
      return;
    }
    if (k.name === 'enter') return this.activateDirectoryItem();
  },

  async switchDirectory(path) {
    const picker = pickerState(this);
    if (picker.switching) return null;
    picker.switching = true;
    picker.error = '';
    picker.pulse.set(1, true);
    picker.pulse.set(0);
    this.s?.invalidate();
    try {
      const base = picker.path || this.st.cwdPath || this.backend?.cwd || process.cwd();
      const cwd = await resolveDirectory(path, base);
      const current = this.st.cwdPath || this.backend?.cwd || process.cwd();
      if (sameDirectory(cwd, current)) {
        picker.switching = false;
        this.closeDirectoryPicker();
        this.toast?.('folder already open', 'info');
        return cwd;
      }

      if (this.backend) {
        if (typeof this.backend.changeDirectory !== 'function') {
          throw new Error('Connected backend has no folder-switch command');
        }
        await this.backend.changeDirectory(cwd);
      } else {
        process.chdir(cwd);
      }

      // A backend event may already have landed the change. Keep this idempotent.
      if (!sameDirectory(this.st.cwdPath || current, cwd)) {
        this.st.cwdPath = cwd;
        this.st.cwd = formatWorkingDirectory(cwd);
        this.resetTranscriptView?.();
        this.st.turns = 0;
        this.st.history = [];
        this.st.histIdx = -1;
        if (!this.backend) this.seed?.();
      }
      picker.switching = false;
      this.closeDirectoryPicker();
      this.toast?.(`opened ${basename(cwd) || cwd}`, 'ok');
      return cwd;
    } catch (error) {
      picker.switching = false;
      picker.error = String(error?.message ?? error);
      this.toast?.('folder switch failed', 'warn');
      this.s?.invalidate();
      return null;
    }
  },

  stepDirectoryPicker(dt) {
    const picker = pickerState(this);
    picker.anim.step(dt);
    picker.cursor.step(dt);
    picker.travel.step(dt);
    picker.pulse.step(dt);
  },
};

export { DIRECTORY_ROWS };
