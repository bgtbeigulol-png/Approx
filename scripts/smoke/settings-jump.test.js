import * as smoke from './shared.js';

const {
  Screen, enterTui, attach, decode, wrapText, ellipsize, padTo,
  strWidth, rgb, mix, moveTo, HIDE_CURSOR, SHOW_CURSOR, CURSOR_STEADY_BAR,
  SAVE_CURSOR, RESTORE_CURSOR, SYNC_START, SYNC_END, clipboardSequence,
  Spring, Tween, ease, clamp, drawSplash, SPLASH_MS,
  drawPalette, fuzzy, filterCommands, paletteLayout,
  drawTranscript, layout, totalHeight, visibleLines, drawGit,
  buildFileChanges, parseGitStatus, railTicks, tickAtRow, tickLabel, RAIL_W,
  settingsModel, settingsRows, applySetting,
  drawJumpList, jumpResults, jumpLabel, jumpLayout, logicalTimeline,
  drawComposer, drawCompact, drawPlanPanel,
  layoutComposerInput, setComposerInput, insertComposerText, moveComposerCursor,
  applyPlanOperation, buildPlanTurnInjection, createPlanState, serializePlanState,
  createApproxHostTools, createApprodeState, approdeRows, navigableRows,
  loadPreferences, savePreferences, Harness, App, createAppState, PiBackend,
  toolMessages, T, paper, drawPaperGrain,
  EventEmitter, spawnSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
  tmpdir, join, SAMPLE_LONG, ok, recordError, FakeOut,
} = smoke;
// ---- settings model + page ----
{
  const c = new App({ noSplash: true });
  c.s = new Screen(new FakeOut(90, 30));
  c.seed();

  const rows = settingsRows(settingsModel(c));
  ok('settings model has rows', rows.length >= 6);
  ok('settings rows carry keys', rows.every((r) => typeof r.key === 'string'));

  // opening routes to the page and arms the enter spring
  c.openSettings();
  ok('open routes to settings view', c.st.view === 'settings');
  ok('settings enter spring armed', c.st.settingsAnim.target === 1);

  // ^o and esc both close; a bare key never leaks to the composer while on the page
  c.onKey({ name: 'x', printable: true });
  ok('settings page swallows typing', c.st.input === '');

  // vertical move wraps and drives the cursor spring toward the new index
  const n = rows.length;
  c.st.settingsIndex = 0;
  c.settingsMove(-1);
  ok('settings move wraps to bottom', c.st.settingsIndex === n - 1);
  ok('settings cursor targets the index', c.st.settingsCursor.target === n - 1);
  c.settingsMove(1);
  ok('settings move wraps to top', c.st.settingsIndex === 0);

  // Paper grain stays on by default but no longer occupies a settings row.
  ok('paper grain setting row removed', !rows.some((r) => r.key === 'grain') && c.st.grain === true);

  // Changing the auto-compact basis updates the shared runtime setting path.
  const compactModeRow = rows.findIndex((r) => r.key === 'autoCompactMode');
  c.st.settingsIndex = compactModeRow;
  c.settingsAdjust(1);
  ok('settings switches auto compact basis', c.st.autoCompactMode === 'tokens');
  ok('settings change fires flash', c.st.settingsFlash.target === 0 && c.st.settingsFlash.v > 0);

  // a select wraps through its options
  const accentRow = rows.findIndex((r) => r.key === 'accent');
  c.st.settingsIndex = accentRow;
  const accBefore = c.st.accent;
  c.settingsAdjust(1);
  ok('settings select advances', c.st.accent !== accBefore);

  // Update actions expose progress and the completed result inside the settings
  // page itself, where the full-page wash intentionally covers the status toast.
  let finishSettingsUpdate;
  c._checkForUpdate = () => new Promise((resolve) => { finishSettingsUpdate = resolve; });
  const updateRow = settingsRows(settingsModel(c)).findIndex((r) => r.key === 'checkUpdates');
  c.st.settingsIndex = updateRow;
  c.settingsKey({ name: 'enter' });
  ok('settings update action shows progress and flashes immediately', c.st.update.checking
    && settingsRows(settingsModel(c))[updateRow].label === 'Checking for updates'
    && c.st.settingsFlash.v > 0);
  finishSettingsUpdate({ available: false, channel: 'npm', currentVersion: '1.2.0', version: '1.2.0' });
  await c._updateCheck;
  ok('settings update action retains a visible completed result',
    settingsRows(settingsModel(c))[updateRow].label === 'Up to date · 1.2.0'
    && c.st.toast.includes('up to date via npm'));

  // frame rate is locked at 60 — there is no runtime setter and no row for it
  ok('clock is locked at 60fps', Math.abs(c.clock.interval - 1000 / 60) < 0.01);
  ok('no frame-rate setting row', !rows.some((r) => r.key === 'fps'));

  // esc returns to chat and starts the exit animation
  c.onKey({ name: 'escape' });
  ok('escape leaves settings', c.st.view === 'chat' && c.st.settingsAnim.target === 0);

  // page renders across its whole open animation without throwing
  let settingsThrew = null;
  try {
    c.openSettings();
    for (let i = 0; i < 40; i++) c.tick(1 / 30, i / 30, i);
    c.render(1);
  } catch (e) { settingsThrew = e; }
  ok('settings page renders', !settingsThrew);

  // The page chrome: masthead counter, numbered section rules, and the inspector
  // strip explaining the selected row. Read the cells back so a silent layout
  // regression fails here rather than in someone's terminal.
  const lineAt = (scr, y) => scr.ch.slice(y * scr.w, (y + 1) * scr.w).map((ch) => ch || ' ').join('');
  const page = () => {
    const out = [];
    for (let y = 0; y < c.s.h; y++) out.push(lineAt(c.s, y));
    return out.join('\n');
  };

  ok('settings masthead titled', lineAt(c.s, 0).includes('S E T T I N G S'));
  ok('settings masthead counts rows', lineAt(c.s, 0).includes(`01/${String(rows.length).padStart(2, '0')}`));
  ok('settings numbers its sections', page().includes('01 APPEARANCE') && page().includes('02 MOTION'));
  ok('settings tags section size', /02 MOTION\s+━+\s+2/.test(page()));
  ok('settings rows carry a dotted leader', /01 Accent\s*·{4}/.test(page()));
  ok('settings inspector names the row', page().includes('ACCENT'));
  ok('settings inspector shows the hint', page().includes(rows[0].hint));
  ok('settings footer offers the keys', page().includes('move') && page().includes('change'));

  // Every row needs inspector copy; a missing hint would silently fall back.
  ok('every settings row has a hint', rows.every((r) => typeof r.hint === 'string' && r.hint.length > 8));

  // A short terminal must scroll the list, not quietly clip the last sections.
  c.s = new Screen(new FakeOut(54, 20));
  c.st.settingsIndex = rows.length - 1;
  c.st.settingsCursor.set(rows.length - 1, true);
  c.st.settingsAnim.set(1, true);
  c.render(1);
  const short = page();
  const currentRows = settingsRows(settingsModel(c));
  ok('short settings page keeps the cursor visible', short.includes(currentRows.at(-1).label));
  ok('short settings page cues more above', short.includes('▲'));

  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}

// ---- applySetting: the shared write path a harness uses ----
{
  const c = new App({ noSplash: true });
  c.s = new Screen(new FakeOut(80, 24));
  c.seed();

  ok('applySetting selects compact basis', applySetting(c, 'autoCompactMode', 'tokens') === 'tokens'
    && c.st.autoCompactMode === 'tokens');
  ok('applySetting selects token threshold', applySetting(c, 'autoCompactThreshold', '64K') === '64K'
    && c.st.autoCompactTokens === 65536);
  const startupTokens = createAppState({ preferences: { autoCompactTokens: 50000 } }).autoCompactTokens;
  c.setAutoCompactTokens(50000);
  const compactBackend = new PiBackend();
  compactBackend.setAutoCompactThreshold({ mode: 'tokens', tokens: 50000 });
  ok('compact token normalization is shared by startup, runtime, and backend',
    startupTokens === 65536 && c.st.autoCompactTokens === 65536
    && compactBackend.autoCompactThreshold.tokens === 65536);
  applySetting(c, 'autoCompactMode', 'percent');
  ok('applySetting selects percent threshold', applySetting(c, 'autoCompactThreshold', '70%') === '70%'
    && c.st.autoCompactPercent === 70);
  ok('applySetting select by label', applySetting(c, 'accent', 'teal') === 'teal' && c.st.accent === 1);
  ok('applySetting select by index', applySetting(c, 'accent', 0) === 'vermilion' && c.st.accent === 0);

  let bad = false;
  try { applySetting(c, 'nope', 1); } catch { bad = true; }
  ok('applySetting rejects unknown key', bad);
  let badVal = false;
  try { applySetting(c, 'accent', 'chartreuse'); } catch { badVal = true; }
  ok('applySetting rejects bad value', badVal);

  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}

// ---- quick-jump sidebar ----
{
  const c = new App({ noSplash: true });
  c.s = new Screen(new FakeOut(90, 30));
  c.seed();
  for (let i = 0; i < 8; i++) c.push({ role: i % 2 ? 'approx' : 'user', text: `message ${i} body`, enter: 1 });

  ok('jump omits system chrome and indexes logical turn rows', jumpResults(c.st.msgs, '').length === c.st.msgs.length - 1);
  ok('jump filter narrows', jumpResults(c.st.msgs, 'message 3').length === 1);
  ok('jump label collapses whitespace', jumpLabel({ role: 'user', text: 'a\n\n  b' }) === 'a b');

  const interleaved = [
    { role: 'system', text: 'session chrome' },
    { role: 'user', text: 'repair the renderer' },
    { role: 'approx', text: 'I will inspect it', stopReason: 'toolUse' },
    { role: 'tool', name: 'read', title: 'Read screen.js', modelTitle: true },
    { role: 'approx', text: 'The compositor needs another check', stopReason: 'toolUse' },
    { role: 'toolgroup', title: 'Audit render path', modelTitle: true, tools: [
      { role: 'tool', name: 'grep', title: 'Search wide cells' },
      { role: 'tool', name: 'read', title: 'Read ANSI code' },
    ] },
    { role: 'approx', text: 'Fixed and verified', stopReason: 'stop' },
  ];
  const logical = logicalTimeline(interleaved);
  ok('jump collapses interleaved tools and notes into one WORK row', logical.map((item) => item.msg.role).join('|') === 'user|work|approx'
    && logical[1].msg.text.includes('3 tools') && logical[1].msg.text.includes('2 notes'));
  ok('WORK exposes child tools only to the secondary view', logical[1].children.length === 3
    && logical[1].children.every((item) => item.msg.role === 'tool'));
  const providerRoles = logicalTimeline([
    { role: 'user', text: 'provider-shaped turn' },
    { role: 'assistant', text: 'progress', stopReason: 'toolUse' },
    { role: 'tool', name: 'read', title: 'Read file' },
    { role: 'assistant', text: 'final', stopReason: 'stop' },
  ]);
  ok('jump normalizes provider assistant roles into WORK and APPROX', providerRoles.map((item) => item.msg.role).join('|') === 'user|work|approx');
  ok('WORK exists only as a jump synthetic row', !interleaved.some((msg) => msg.role === 'work')
    && logical[1].index === 2);
  ok('jump search finds a child tool through its WORK parent', jumpResults(interleaved, 'wide cells')[0]?.kind === 'work');

  const logicalApp = new App({ noSplash: true });
  logicalApp.s = new Screen(new FakeOut(90, 30));
  logicalApp.st.msgs = interleaved;
  logicalApp.openJump();
  ok('jump UI consumes logical rows', logicalApp.st.jumpResults.map((item) => item.msg.role).join('|') === 'user|work|approx');
  logicalApp.st.jumpIndex = 1;
  logicalApp.jumpKey({ name: 'right' });
  ok('jump right enters WORK children', logicalApp.st.jumpDepth === 1 && logicalApp.st.jumpResults.length === 3);
  logicalApp.jumpKey({ name: 'left' });
  ok('jump left returns to top-level timeline', logicalApp.st.jumpDepth === 0
    && logicalApp.st.jumpResults.map((item) => item.msg.role).join('|') === 'user|work|approx');

  c.openJump();
  ok('jump opens', c.st.jump && c.st.jumpResults.length > 0);
  // typing filters, backspace restores
  c.onKey({ name: 'm', printable: true });
  c.onKey({ name: 'e', printable: true });
  ok('jump typing filters', c.st.jumpQuery === 'me');
  c.onKey({ name: 'backspace' });
  ok('jump backspace edits query', c.st.jumpQuery === 'm');

  // move + wheel both walk the list and keep the window on the selection
  c.st.jumpQuery = '';
  c.refreshJump();
  c.st.jumpIndex = 0;
  c.clampJumpScroll();
  c.jumpMove(1); c.jumpMove(1);
  ok('jump move advances', c.st.jumpIndex === 2);
  ok('jump window holds the selection', c.st.jumpIndex >= c.st.jumpScroll);
  c.onKey({ name: 'wheeldown', mouse: true, x: 0, y: 0 });
  ok('jump wheel moves selection', c.st.jumpIndex === 3);

  // enter jumps and closes, reusing the wiper
  c.scrollTo(0);
  const target = c.st.jumpResults[5];
  c.st.jumpIndex = 5;
  c.onKey({ name: 'enter' });
  ok('jump enter closes the list', !c.st.jump);
  ok('jump enter moves the transcript', c.st.scrollTarget >= 0);

  // ^g toggles it shut; esc too
  c.openJump();
  c.onKey({ name: 'escape' });
  ok('jump esc closes', !c.st.jump);

  // renders across the open animation
  let jumpThrew = null;
  try {
    c.openJump();
    for (let i = 0; i < 30; i++) c.tick(1 / 30, i / 30, i);
    c.render(1);
  } catch (e) { jumpThrew = e; }
  ok('jump list renders', !jumpThrew);

  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}
