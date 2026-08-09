const MAX_DAYS = 90;

export function createUsageHistory(seed = {}) {
  const rawDays = Array.isArray(seed) ? seed : seed.days;
  const days = (rawDays ?? [])
    .map(normalizeDay)
    .filter(Boolean)
    .sort((left, right) => left.day.localeCompare(right.day))
    .slice(-MAX_DAYS);
  return { days };
}

export function serializeUsageHistory(history) {
  return {
    days: createUsageHistory(history).days.map((day) => ({
      ...day,
      models: { ...day.models },
      efforts: { ...day.efforts },
    })),
  };
}

export function recordUsage(history, event = {}, now = new Date()) {
  const state = history?.days ? history : createUsageHistory();
  const dayKey = localDay(now);
  let day = state.days.find((item) => item.day === dayKey);
  if (!day) {
    day = blankDay(dayKey);
    state.days.push(day);
    state.days.sort((left, right) => left.day.localeCompare(right.day));
    if (state.days.length > MAX_DAYS) state.days.splice(0, state.days.length - MAX_DAYS);
  }
  const input = finite(event.inputTokens ?? event.input);
  const output = finite(event.outputTokens ?? event.output);
  const cacheRead = finite(event.cacheReadTokens ?? event.cacheRead ?? event.cache);
  const cacheWrite = finite(event.cacheWriteTokens ?? event.cacheWrite);
  const cost = finite(event.cost);
  day.input += input;
  day.output += output;
  day.cacheRead += cacheRead;
  day.cacheWrite += cacheWrite;
  day.cost += cost;
  const total = input + output + cacheRead + cacheWrite;
  addDistribution(day.models, String(event.model || 'unknown'), total);
  addDistribution(day.efforts, String(event.effort || 'default'), total);
  return day;
}

export function usageTotals(history, { since } = {}) {
  const days = createUsageHistory(history).days.filter((day) => !since || day.day >= since);
  return days.reduce((total, day) => ({
    input: total.input + day.input,
    output: total.output + day.output,
    cacheRead: total.cacheRead + day.cacheRead,
    cacheWrite: total.cacheWrite + day.cacheWrite,
    cost: total.cost + day.cost,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
}

export function usageDistribution(history, key, { since } = {}) {
  const merged = {};
  for (const day of createUsageHistory(history).days) {
    if (since && day.day < since) continue;
    for (const [name, value] of Object.entries(day[key] ?? {})) addDistribution(merged, name, value);
  }
  return Object.entries(merged)
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value);
}

export function usageCacheWriteTotal(history, { since } = {}) {
  return usageTotals(history, { since }).cacheWrite;
}

export function recentUsageDays(history, count = 28, now = new Date()) {
  const lookup = new Map(createUsageHistory(history).days.map((day) => [day.day, day]));
  const days = [];
  for (let offset = Math.max(0, count - 1); offset >= 0; offset--) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    const key = localDay(date);
    days.push(lookup.get(key) ?? blankDay(key));
  }
  return days;
}

function normalizeDay(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.day))) return null;
  return {
    day: String(value.day),
    input: finite(value.input),
    output: finite(value.output),
    cacheRead: finite(value.cacheRead),
    cacheWrite: finite(value.cacheWrite),
    cost: finite(value.cost),
    models: normalizeDistribution(value.models),
    efforts: normalizeDistribution(value.efforts),
  };
}

function blankDay(day) {
  return { day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: {}, efforts: {} };
}

function normalizeDistribution(value) {
  const output = {};
  for (const [key, amount] of Object.entries(value ?? {})) {
    const name = String(key).slice(0, 160);
    if (name) output[name] = finite(amount);
  }
  return output;
}

function addDistribution(target, key, amount) {
  if (!key || !Number.isFinite(amount) || amount <= 0) return;
  target[key] = finite(target[key]) + amount;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function localDay(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
