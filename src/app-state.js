import { Spring, clamp } from './anim.js';
import { createDirectoryPickerState, formatWorkingDirectory } from './directories.js';
import { createPlanState } from './plan.js';
import { createQuestionnaireState } from './questionnaire.js';
import { createSessionPickerState } from './sessions.js';
import { ACCENTS as ACCENT_DEFS } from './settings.js';

export const APP_ACCENTS = ACCENT_DEFS.map((accent) => accent.color);

/** Build the mutable UI state graph without coupling it to the App lifecycle. */
export function createAppState({ noSplash = false, backend = null, preferences = {}, initialCwd }) {
  const pref = preferences;
  return {
    phase: noSplash ? 'main' : 'splash',
    view: 'chat',
    age: 0,
    splashMs: 0,
    msgs: [],
    input: '',
    inputCursor: 0,
    _cursorInput: '',
    busy: false,
    elapsed: 0,
    scroll: 0,
    scrollTarget: 0,
    scrollSpring: new Spring(0, { stiff: 18, damp: 1.12 }),
    atBottom: true,
    scrollPct: 1,
    turns: 0,
    frames: 0,
    cwdPath: initialCwd,
    cwd: formatWorkingDirectory(initialCwd),
    branch: 'master',
    model: backend ? 'Approx' : 'approx-1',
    modelOptions: [],
    runtime: backend ? 'Approx' : 'scripted',
    effort: '',
    effortOptions: [],
    pendingModel: null,
    pendingEffort: '',
    markdown: pref.markdown !== false,
    sessionId: '',
    ctxUse: new Spring(0.06, { stiff: 6, damp: 1 }),
    ctxTokens: 0,
    contextWindow: 0,
    autoCompactMode: pref.autoCompactMode === 'tokens' ? 'tokens' : 'percent',
    autoCompactPercent: validCompactPercent(pref.autoCompactPercent),
    autoCompactTokens: validCompactTokens(pref.autoCompactTokens),
    compact: {
      seq: 0,
      active: false,
      phase: 'idle',
      reason: 'manual',
      startedAt: 0,
      finishedAt: 0,
      tokensBefore: null,
      tokensAfter: null,
      error: '',
      enter: new Spring(0, { stiff: 20, damp: 0.82 }),
      progress: new Spring(0, { stiff: 12, damp: 0.9 }),
      pulse: new Spring(0, { stiff: 18, damp: 0.72 }),
    },
    tps: new Array(18).fill(0),
    tpsNow: 0,
    focusAnim: new Spring(1, { stiff: 14, damp: 0.8 }),
    railTicks: [],
    railHover: -1,
    railBulge: new Spring(0, { stiff: 22, damp: 1 }),
    railAmt: new Spring(0, { stiff: 18, damp: 1 }),
    wipe: 0,
    wipeDir: 1,
    palette: false,
    paletteAnim: new Spring(0, { stiff: 17, damp: 0.82 }),
    paletteQuery: '',
    paletteIndex: 0,
    paletteScroll: 0,
    paletteResults: [],
    slashMatches: [],
    slashIndex: 0,
    slashScroll: 0,
    slashAnim: new Spring(0, { stiff: 18, damp: 0.85 }),
    settingsAnim: new Spring(0, { stiff: 18, damp: 0.86 }),
    settingsIndex: 0,
    settingsCursor: new Spring(0, { stiff: 20, damp: 0.9 }),
    settingsFlash: new Spring(0, { stiff: 10, damp: 1 }),
    toolFocus: null,
    jump: false,
    jumpAnim: new Spring(0, { stiff: 18, damp: 0.84 }),
    jumpQuery: '',
    jumpIndex: 0,
    jumpScroll: 0,
    jumpResults: [],
    jumpDepth: 0,
    jumpParent: null,
    messageQueue: [],
    queueGhosts: [],
    queueHits: [],
    queueAnim: new Spring(0, { stiff: 20, damp: 0.88 }),
    queuePulse: new Spring(0, { stiff: 15, damp: 0.76 }),
    toast: null,
    toastKind: 'info',
    toastLife: 0,
    toastMax: 2.4,
    grain: true,
    reduceMotion: !!pref.reduceMotion,
    showFps: !!pref.showFps,
    accent: clamp(Number(pref.accent) || 0, 0, APP_ACCENTS.length - 1),
    dirtyAvg: 0,
    history: [],
    histIdx: -1,
    draft: '',
    messageEdit: {
      mode: 'idle',
      target: null,
      draft: '',
      originalComposer: '',
      messageCount: 0,
      mutationCount: 0,
      mutations: [],
      mutationCallIds: [],
    },
    rewindAnim: new Spring(0, { stiff: 20, damp: 0.86 }),
    redo: null,
    pointerDown: null,
    textSelection: null,
    lastUserClick: null,
    sessionPicker: createSessionPickerState(),
    directoryPicker: createDirectoryPickerState(initialCwd),
    plan: createPlanState(),
    questionnaire: createQuestionnaireState(),
  };
}

function validCompactPercent(value) {
  const percent = Number(value);
  return Number.isInteger(percent) && percent >= 10 && percent <= 100 && percent % 10 === 0
    ? percent : 80;
}

function validCompactTokens(value) {
  const tokens = Number(value);
  const ratio = tokens / 32768;
  return Number.isInteger(tokens) && tokens >= 32768 && tokens <= 2097152
    && Number.isInteger(Math.log2(ratio)) ? tokens : 32768;
}
