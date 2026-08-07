export const AUTO_COMPACT_PERCENT_OPTIONS = Array.from({ length: 10 }, (_, i) => (i + 1) * 10);
export const AUTO_COMPACT_TOKEN_OPTIONS = Array.from({ length: 7 }, (_, i) => 32768 * (2 ** i));

function closestOption(value, options, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return options.reduce((best, option) =>
    Math.abs(option - n) < Math.abs(best - n) ? option : best, options[0]);
}

export function normalizeAutoCompactMode(value) {
  return value === 'tokens' ? 'tokens' : 'percent';
}

export function normalizeAutoCompactPercent(value) {
  return closestOption(value, AUTO_COMPACT_PERCENT_OPTIONS, 80);
}

export function normalizeAutoCompactTokens(value) {
  return closestOption(value, AUTO_COMPACT_TOKEN_OPTIONS, 32768);
}
