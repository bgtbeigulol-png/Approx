// Settings model. One schema, three consumers: the settings page renders it, the
// harness `set` command writes through it, and the palette / slash layer reads it
// for command labels. Keeping the schema here — not in the view — is what lets a
// driver change the compact threshold without knowing a settings page exists.

import { C } from './theme.js';

export const ACCENTS = [
  { name: 'vermilion', color: C.vermilion },
  { name: 'teal', color: C.teal },
  { name: 'moss', color: C.moss },
  { name: 'plum', color: C.plum },
  { name: 'ember', color: C.ember },
];

export const AUTO_COMPACT_PERCENT_OPTIONS = Array.from({ length: 10 }, (_, i) => (i + 1) * 10);
export const AUTO_COMPACT_TOKEN_OPTIONS = Array.from({ length: 7 }, (_, i) => 32768 * (2 ** i));

export function formatCompactTokens(tokens) {
  const value = Number(tokens) || 0;
  if (value >= 1024 * 1024) return `${value / (1024 * 1024)}M`;
  return `${Math.round(value / 1024)}K`;
}

/**
 * Build the settings model bound to a live app. Each item is one row on the page
 * and one addressable `key` for the harness. `get`/`set` touch app state directly
 * so there is a single source of truth; the view never caches a value.
 *
 * types:
 *   toggle  — boolean, ON/OFF slab
 *   select  — index into `options`, `‹ label ›`
 *   action  — a one-shot, fired on enter
 */
export function settingsModel(app) {
  const st = app.st;
  const models = st.modelOptions.length
    ? st.modelOptions
    : [{ provider: '', id: st.model, label: st.model }];
  return [
    {
      title: 'APPEARANCE',
      items: [
        {
          key: 'accent', label: 'Accent', type: 'select',
          options: ACCENTS.map((a) => a.name),
          swatch: ACCENTS.map((a) => a.color),
          get: () => st.accent,
          set: (i) => app.setAccent(i),
        },
      ],
    },
    {
      title: 'MOTION',
      items: [
        {
          key: 'reduceMotion', label: 'Reduce motion', type: 'toggle',
          get: () => st.reduceMotion,
          set: (v) => app.setReduceMotion(v),
        },
        {
          key: 'showFps', label: 'Frame meter', type: 'toggle',
          get: () => st.showFps,
          set: (v) => app.setShowFps(v),
        },
      ],
    },
    {
      title: 'SESSION',
      items: [
        {
          key: 'model', label: st.pendingModel ? 'Model · pending' : 'Model', type: 'select',
          options: models.map((model) => model.label),
          get: () => Math.max(0, models.findIndex((model) => model.label === (st.pendingModel?.label ?? st.model))),
          set: (i) => app.setModel(models[i]),
        },
        {
          key: 'effort', label: st.pendingEffort ? 'Reasoning effort · pending' : 'Reasoning effort', type: 'select',
          options: st.effortOptions.length ? st.effortOptions : [st.effort || 'default'],
          get: () => Math.max(0, (st.effortOptions.length ? st.effortOptions : [st.effort || 'default']).indexOf(st.pendingEffort || st.effort)),
          set: (i) => app.setEffort((st.effortOptions.length ? st.effortOptions : [st.effort || 'default'])[i]),
        },
        {
          key: 'markdown', label: 'Markdown', type: 'select',
          options: ['on', 'off'],
          get: () => st.markdown ? 0 : 1,
          set: (i) => app.setMarkdown(i === 0),
        },
        {
          key: 'autoCompactMode', label: 'Auto compact by', type: 'select',
          options: ['percent', 'tokens'],
          get: () => st.autoCompactMode === 'tokens' ? 1 : 0,
          set: (i) => app.setAutoCompactMode(i === 1 ? 'tokens' : 'percent'),
        },
        {
          key: 'autoCompactThreshold', label: 'Auto compact at', type: 'select',
          options: st.autoCompactMode === 'tokens'
            ? AUTO_COMPACT_TOKEN_OPTIONS.map(formatCompactTokens)
            : AUTO_COMPACT_PERCENT_OPTIONS.map((value) => `${value}%`),
          get: () => st.autoCompactMode === 'tokens'
            ? Math.max(0, AUTO_COMPACT_TOKEN_OPTIONS.indexOf(st.autoCompactTokens))
            : Math.max(0, AUTO_COMPACT_PERCENT_OPTIONS.indexOf(st.autoCompactPercent)),
          set: (i) => st.autoCompactMode === 'tokens'
            ? app.setAutoCompactTokens(AUTO_COMPACT_TOKEN_OPTIONS[i])
            : app.setAutoCompactPercent(AUTO_COMPACT_PERCENT_OPTIONS[i]),
        },
        {
          key: 'clear', label: 'Clear context', type: 'action',
          run: () => app.clearTranscript(),
        },
        {
          key: 'history', label: 'Saved conversations', type: 'action',
          run: () => app.openSessions(),
        },
        {
          key: 'about', label: 'About Approx', type: 'action',
          run: () => { app.closeSettings(); app.later(() => app.showAbout(), 120); },
        },
      ],
    },
  ];
}

/** Flat list of just the interactive rows, in page order — the cursor walks this. */
export function settingsRows(model) {
  const rows = [];
  for (const sec of model) for (const it of sec.items) rows.push(it);
  return rows;
}

/**
 * Apply a value by key, coercing to the item's type. Returns the resolved value
 * or throws for an unknown key / bad value — the harness turns that into an error
 * event rather than silently dropping a driver's command.
 */
export function applySetting(app, key, value) {
  const model = settingsModel(app);
  const item = settingsRows(model).find((r) => r.key === key);
  if (!item) throw new Error(`unknown setting: ${key}`);
  if (item.type === 'action') {
    item.run();
    return null;
  }
  if (item.type === 'toggle') {
    const v = typeof value === 'string' ? /^(1|true|on|yes)$/i.test(value) : !!value;
    item.set(v);
    return v;
  }
  // select: accept an index or a label
  let idx = -1;
  if (typeof value === 'number') idx = value;
  else idx = item.options.findIndex((o) => o.toLowerCase() === String(value).toLowerCase());
  if (idx < 0 || idx >= item.options.length) throw new Error(`bad value for ${key}: ${value}`);
  item.set(idx);
  return item.options[idx];
}
