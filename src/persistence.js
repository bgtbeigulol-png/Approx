// Small local preference store. Conversation bodies remain in the runtime's
// append-only session files; this file only keeps UI choices and the last model.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function settingsPath(env = process.env) {
  const base = env.APPDATA || env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'Approx', 'settings.json');
}

export function loadPreferences(path = settingsPath()) {
  try {
    if (!existsSync(path)) return {};
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function savePreferences(value, path = settingsPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}
