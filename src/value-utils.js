export function cleanText(value, max = 12_000) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim().slice(0, max);
}

export function finiteInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
