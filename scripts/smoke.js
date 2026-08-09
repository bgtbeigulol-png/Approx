// Headless smoke entry point. Suites run serially because they exercise shared
// process state such as terminal dimensions, the theme, and temporary timers.

const suites = [
  './smoke/core.test.js',
  './smoke/file-mentions.test.js',
  './smoke/workflows.test.js',
  './smoke/rendering.test.js',
  './smoke/app-navigation.test.js',
  './smoke/settings-jump.test.js',
  './smoke/runtime-queue.test.js',
  './smoke/runtime-history.test.js',
  './smoke/backend.test.js',
  './smoke/workspace.test.js',
];

for (const suite of suites) await import(suite);

const { report } = await import('./smoke/shared.js');
report();
