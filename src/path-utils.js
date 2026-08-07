import { resolve } from 'node:path';

export function samePath(left, right) {
  const a = resolve(String(left ?? ''));
  const b = resolve(String(right ?? ''));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
