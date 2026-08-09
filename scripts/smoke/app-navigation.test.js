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
// ---- full app drive: real render loop against the fake TTY ----
const realCols = process.stdout.columns;
const realRows = process.stdout.rows;
const app = new App({ noSplash: true });
app.s = new Screen(new FakeOut(100, 30));
app.seed();
app.st.input = '/';
app.refreshSlash();
ok('stream demo command is not exposed', !app.cmds.some((command) => command.name === 'stream')
  && !app.st.slashMatches.some((item) => item.name === '/stream'));
ok('/new is slash-addressable but stays out of curated palette', app.cmds.some((command) => command.name === 'new')
  && app.st.slashMatches.some((item) => item.name === '/new')
  && !app.cmds.find((command) => command.name === 'new').palette);
app.st.input = '';
app.refreshSlash();
const literalUser = app.push({ role: 'user', text: '**literal input**', enter: 1 });
ok('user input stays literal under markdown mode', layout(literalUser, 40).some((line) => line.text.includes('**')));

let appThrew = null;
try {
  // type a prompt, submit it, stream the reply, scroll, open the palette
  for (const ch of 'build the thing') app.onKey({ name: ch, printable: true });
  ok('input accumulated', app.st.input === 'build the thing');
  app.onKey({ name: 'enter' });
  ok('message pushed', app.st.msgs.some((x) => x.role === 'user'));

  for (let i = 0; i < 240; i++) app.tick(1 / 30, i / 30, i);
  ok('render loop ran', app.st.frames === 239);

  // slash menu
  app.onKey({ name: '/', printable: true });
  app.onKey({ name: 'h', printable: true });
  ok('slash filters', app.st.slashMatches.length > 0);
  app.onKey({ name: 'escape' });
  // Escape stops the active turn but preserves the typed draft; clear it here so
  // the next assertion starts a fresh slash query.
  setComposerInput(app.st, '');
  app.refreshSlash();

  // slash menu scroll window: index past the visible rows must drag the window
  app.onKey({ name: '/', printable: true });
  ok('slash full list', app.st.slashMatches.length > 6 && app.st.slashScroll === 0);
  for (let i = 0; i < 6; i++) app.onKey({ name: 'down' });
  ok('slash index advanced', app.st.slashIndex === 6);
  ok('slash window followed', app.st.slashIndex >= app.st.slashScroll && app.st.slashIndex < app.st.slashScroll + 5);
  // wrap from top back to bottom keeps the selection visible too
  app.onKey({ name: 'up' });
  app.onKey({ name: 'up' });
  app.onKey({ name: 'up' });
  app.onKey({ name: 'up' });
  app.onKey({ name: 'up' });
  app.onKey({ name: 'up' });
  app.onKey({ name: 'up' });
  ok('slash wrap to bottom visible', app.st.slashIndex >= app.st.slashScroll && app.st.slashIndex < app.st.slashScroll + 5);
  // re-filtering resets the window to the top
  app.onKey({ name: 't', printable: true });
  ok('slash refilter resets scroll', app.st.slashScroll === 0 && app.st.slashIndex === 0);
  app.onKey({ name: 'escape' });
  ok('escape clears input', app.st.input === '');

  // palette open, filter, move, close
  app.openPalette();
  ok('palette keeps eleven curated controls plus Git, history, and approde', app.st.paletteResults.length === 11
    && app.st.paletteResults.some((item) => item.name === 'history')
    && app.st.paletteResults.some((item) => item.name === 'git')
    && app.st.paletteResults.some((item) => item.name === 'approde')
    && app.st.paletteResults.every((item) => item.palette) && !app.st.paletteResults.some((item) => item.name === 'help'));
  app.onKey({ name: 't', printable: true });
  app.onKey({ name: 'down' });
  for (let i = 0; i < 30; i++) app.tick(1 / 30, i / 30, i);
  ok('palette open', app.st.palette && app.st.paletteResults.length > 0);
  app.onKey({ name: 'escape' });
  ok('palette closed', !app.st.palette);

  // scrolling clamps
  app.scrollTo(99999);
  ok('scroll clamped', app.st.scrollTarget === app.maxScroll());
  app.scrollBy(-99999);
  ok('scroll clamped low', app.st.scrollTarget === 0);

  // commands run without throwing
  for (const c of app.cmds) {
    if (c.name === 'quit') continue;
    c.run();
  }
  for (let i = 0; i < 60; i++) app.tick(1 / 30, i / 30, i);
  ok('all commands survive', true);

  // resize mid-flight
  app.s = new Screen(new FakeOut(48, 14));
  for (const msg of app.st.msgs) { msg._lines = null; msg._lw = -1; }
  for (let i = 0; i < 60; i++) app.tick(1 / 30, i / 30, i);
  ok('narrow render ok', true);

  // interrupt clears busy
  app.fakeStream();
  app.interrupt();
  ok('interrupt clears busy', !app.st.busy);

  // mid-stream resize must preserve progress and still terminate
  app.s = new Screen(new FakeOut(100, 30));
  const sm = app.beginStream(SAMPLE_LONG, 200);
  for (let i = 0; i < 40; i++) app.tick(1 / 30, i / 30, i);
  const fracBefore = sm.streamChars / sm._total;
  process.stdout.columns = 50;
  process.stdout.rows = 24;
  app.s = new Screen(new FakeOut(50, 24));
  app.onResize();
  const fracAfter = sm.streamChars / sm._total;
  ok('resize preserves stream progress', Math.abs(fracBefore - fracAfter) < 0.03);
  for (let i = 0; i < 500 && sm.streaming; i++) app.tick(1 / 30, i / 30, i);
  ok('stream terminates after resize', !sm.streaming);
} catch (e) {
  appThrew = e;
}
ok('app drive clean', !appThrew);
recordError('app', appThrew);

// ---- nav rail: tick placement, labels, hit-testing ----
{
  const mk = (role, text) => ({ role, text, enter: 1 });
  const few = [mk('user', 'first question'), mk('approx', 'an answer'), mk('tool', 'x')];
  const t1 = railTicks(few, 60, 20);
  ok('rail one tick per message', t1.length === 3);
  ok('rail ticks in view', t1.every((tk) => tk.row >= 0 && tk.row < 20));
  ok('rail rows unique', new Set(t1.map((tk) => tk.row)).size === 3);
  ok('rail rows ascend with document', t1[0].row <= t1[1].row && t1[1].row <= t1[2].row);
  ok('rail first tick at top', t1[0].row === 0);

  // more messages than rows: every tick must still land somewhere, none dropped
  const many = Array.from({ length: 40 }, (_, i) => mk(i % 2 ? 'approx' : 'user', `m${i}`));
  const t2 = railTicks(many, 60, 12);
  ok('rail packs into a short rail', t2.length === 12);
  ok('rail no row collisions when packed', new Set(t2.map((tk) => tk.row)).size === t2.length);
  ok('rail packed rows in bounds', t2.every((tk) => tk.row >= 0 && tk.row < 12));
  // the tail is what a jump control cannot lose: the last row must be occupied
  ok('rail fills the bottom row', t2.some((tk) => tk.row === 11));

  ok('rail empty transcript', railTicks([], 60, 20).length === 0);
  ok('rail zero height', railTicks(few, 60, 0).length === 0);

  // hit-testing partitions the rail: every row between the first and last tick
  // belongs to exactly one message, so a fast slide never crosses a dead row
  ok('rail hit exact', tickAtRow(t1, t1[1].row)?.index === 1);
  const spanRows = [];
  for (let r = t1[0].row; r <= t1[2].row; r++) spanRows.push(tickAtRow(t1, r));
  ok('rail no dead rows in span', spanRows.every((h) => h !== null));
  ok('rail span covers every message', new Set(spanRows.map((h) => h.index)).size === 3);
  // ownership changes at the midpoint between neighbours, and only there
  ok('rail owns its own row', spanRows.every((h, i) => {
    const row = t1[0].row + i;
    return Math.abs(h.row - row) <= Math.abs(t1[(h.index + 1) % 3].row - row);
  }));
  // past the ends the rail lets go rather than clamping to the nearest tick
  ok('rail miss when far past bottom', tickAtRow(t1, t1[2].row + 6) === null);
  ok('rail miss when far above top', tickAtRow(t1, t1[0].row - 6) === null);
  ok('rail grace one row past the end', tickAtRow(t1, t1[2].row + 1)?.index === 2);
  const logicalRail = railTicks([
    mk('user', 'inspect project'),
    { role: 'approx', text: 'working', stopReason: 'toolUse' },
    { role: 'tool', name: 'read', title: 'Read files' },
    { role: 'tool', name: 'grep', title: 'Search files' },
    { role: 'approx', text: 'final answer', stopReason: 'stop' },
  ], 60, 20, { logical: true });
  ok('logical rail compresses tool phase into WORK', logicalRail.map((tick) => tick.msg.role).join('|') === 'user|work|approx');
  ok('rail empty ticks miss', tickAtRow([], 3) === null);

  // labels: first 10 characters, whitespace collapsed, CJK counted as characters
  ok('rail label truncates', tickLabel(mk('user', 'abcdefghijklmnop')) === 'abcdefghij…');
  ok('rail label short passthrough', tickLabel(mk('user', 'short')) === 'short');
  ok('rail label collapses whitespace', tickLabel(mk('user', 'a\n\n  b')) === 'a b');
  const cjkLabel = tickLabel(mk('user', '豚鼠娘社区激活机器人正在运行'));
  ok('rail label cjk 10 chars', [...cjkLabel].length === 11 && cjkLabel.endsWith('…'));
  ok('rail label falls back to tool name', tickLabel({ role: 'tool', name: 'measure', text: '' }) === 'measure()');
}

// ---- mouse wheel decoding ----
{
  const up = decode(Buffer.from('\x1b[<64;10;5M'));
  ok('wheel up decodes', up.length === 1 && up[0].name === 'wheelup');
  const dn = decode(Buffer.from('\x1b[<65;10;5M'));
  ok('wheel down decodes', dn.length === 1 && dn[0].name === 'wheeldown');
  ok('wheel carries 0-based coords', up[0].x === 9 && up[0].y === 4);
  // horizontal wheel (66/67) is noise for us; must not surface as vertical
  ok('h-wheel ignored', decode(Buffer.from('\x1b[<66;1;1M')).length === 0);
  ok('mouse release decodes', decode(Buffer.from('\x1b[<0;3;3m'))[0].name === 'mouseup');
  ok('left press decodes', decode(Buffer.from('\x1b[<0;3;3M'))[0].name === 'mousedown');
  // a wheel burst must not be misread as an arrow / cursor sequence
  const burst = decode(Buffer.from('\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M'));
  ok('wheel burst decodes discretely', burst.length === 3);
  ok('wheel burst has no arrows', !burst.some((e) => e.name === 'up' || e.name === 'down'));
  // real arrows still decode after the mouse branch was added
  ok('arrow up still decodes', decode(Buffer.from('\x1b[A'))[0].name === 'up');
}

// ---- arrows vs wheel: the two must not fight over one axis ----
{
  const a = new App({ noSplash: true });
  a.s = app.s;
  a.st.history = ['first prompt', 'second prompt'];
  a.st.histIdx = -1;
  a.st.input = 'half-typed draft';

  // Arrow up = history, and it must leave the transcript scroll alone.
  const scrollBefore = a.st.scrollTarget;
  a.onKey({ name: 'up' });
  ok('arrow up recalls history', a.st.input === 'second prompt');
  ok('arrow up does not scroll content', a.st.scrollTarget === scrollBefore);
  a.onKey({ name: 'up' });
  ok('arrow up walks further back', a.st.input === 'first prompt');
  // Walking off the front clamps rather than wrapping to the draft.
  a.onKey({ name: 'up' });
  ok('history clamps at oldest', a.st.input === 'first prompt');
  a.onKey({ name: 'down' });
  a.onKey({ name: 'down' });
  ok('arrow down restores the draft', a.st.input === 'half-typed draft');
  ok('draft cleared once returned', a.st.draft === '');

  // Wheel = content, and it must not touch the composer.
  for (let i = 0; i < 12; i++) app.push({ role: 'system', text: `scroll fixture ${i}` });
  a.st.msgs = app.st.msgs;
  ok('scroll fixture has room to scroll', a.maxScroll() > 40);
  a.st.input = 'untouched';
  a.st.scrollTarget = 30;
  a.st.atBottom = false;
  a.onKey({ name: 'wheelup', mouse: true, x: 0, y: 0 });
  ok('wheel up scrolls content', a.st.scrollTarget === 27);
  a.onKey({ name: 'wheeldown', mouse: true, x: 0, y: 0 });
  ok('wheel down scrolls content', a.st.scrollTarget === 30);
  ok('wheel leaves composer alone', a.st.input === 'untouched');
  ok('wheel leaves history index alone', a.st.histIdx === -1);
  // Scrolling to the floor must not run negative.
  for (let i = 0; i < 40; i++) a.onKey({ name: 'wheelup', mouse: true, x: 0, y: 0 });
  ok('wheel clamps at top', a.st.scrollTarget === 0);
  // Riding the wheel back down re-arms follow-the-tail.
  for (let i = 0; i < 200; i++) a.onKey({ name: 'wheeldown', mouse: true, x: 0, y: 0 });
  ok('wheel to floor re-arms atBottom', a.st.atBottom === true);

  // With the palette open the wheel drives the list, not the transcript.
  a.st.scrollTarget = 10;
  a.openPalette();
  const palScroll = a.st.scrollTarget;
  a.onKey({ name: 'wheeldown', mouse: true, x: 0, y: 0 });
  ok('wheel drives palette when open', a.st.paletteIndex !== 0);
  ok('wheel spares transcript when palette open', a.st.scrollTarget === palScroll);

  // Responsive paging uses the rows actually visible in a short terminal.
  a.s = new Screen(new FakeOut(24, 9));
  a.onKey({ name: 'end' });
  ok('palette end keeps selection visible in short terminal', a.st.paletteIndex === a.st.paletteResults.length - 1
    && a.st.paletteIndex < a.st.paletteScroll + a.paletteRows());

  // The palette is pointer-modal: hovering selects its row, clicking it schedules
  // that command, and clicking the scrim closes instead of touching content below.
  a.s = new Screen(new FakeOut(80, 24));
  a.closePalette();
  a.openPalette();
  a.st.paletteAnim.v = 1;
  const pg = paletteLayout(a.s.w, a.s.h, a.st.paletteResults.length, 1);
  a.onKey({ name: 'mousemove', mouse: true, x: pg.px + 8, y: pg.resultY + 2 });
  ok('palette hover selects row', a.st.paletteIndex === 2);
  a.onKey({ name: 'mousedown', mouse: true, x: pg.px + 8, y: pg.resultY + 2 });
  ok('palette row click closes and schedules command', !a.st.palette && a.timers.size === 1);
  a.openPalette();
  a.st.paletteAnim.v = 1;
  a.onKey({ name: 'mousedown', mouse: true, x: 0, y: 0 });
  ok('palette scrim click closes modal', !a.st.palette);

  a.clock.stop();
  for (const id of a.timers) clearTimeout(id);
}

// ---- rail hover + click-to-jump drive the real app ----
{
  const b = new App({ noSplash: true });
  b.s = new Screen(new FakeOut(100, 30));
  b.seed();
  for (let i = 0; i < 9; i++) {
    b.push({ role: i % 2 ? 'approx' : 'user', text: `message number ${i} with some body text`, enter: 1 });
  }
  for (let i = 0; i < 30; i++) b.tick(1 / 30, i / 30, i);
  ok('rail populated from logical timeline', b.st.railTicks.length === logicalTimeline(b.st.msgs).length
    && b.st.railTicks.length < b.st.msgs.length);

  const vp = b.viewport();
  const target = b.st.railTicks[3];

  // hovering the rail arms the bulge; the pointer column must be on the rail
  b.onKey({ name: 'mousemove', mouse: true, x: 1, y: vp.y + target.row });
  ok('hover records the message index', b.st.railHover === target.index);
  ok('hover bulge targets the tick row', b.st.railBulge.target === target.row);
  ok('hover amount rises', b.st.railAmt.target === 1);
  ok('hover resolves a live tick', b.railHoverTick()?.index === target.index);

  // A fast slide down the rail hands off tick to tick without ever letting go.
  // Dropping the hover on a gap row starts the fade, and re-arming mid-decay is
  // what made the bulge sweep across ticks and the label float loose.
  {
    const first = b.st.railTicks[0];
    const last = b.st.railTicks[b.st.railTicks.length - 1];
    let lost = 0;
    let decayed = 0;
    const seen = new Set();
    for (let row = first.row; row <= last.row; row++) {
      b.onKey({ name: 'mousemove', mouse: true, x: 1, y: vp.y + row });
      if (b.st.railHover < 0) lost++;
      else seen.add(b.st.railHover);
      if (b.st.railAmt.target !== 1) decayed++;
      b.tick(1 / 30, row / 30, row); // real frames between moves, as in a live slide
    }
    ok('slide never drops the hover', lost === 0);
    ok('slide never starts a fade', decayed === 0);
    ok('slide visits several messages', seen.size >= 4);
    ok('slide ends on the last tick', b.st.railHover === last.index);
    // the bulge must be sitting on the tick it ended on, not still travelling
    ok('bulge caught up to the slide', b.st.railBulge.target === last.row);
    ok('label rides the hovered tick', b.railHoverTick()?.row === last.row);
  }

  // Re-entering far from where the bulge was left snaps: a visible sweep across
  // ticks the pointer never touched reads as the rail glitching.
  b.onKey({ name: 'mousemove', mouse: true, x: RAIL_W + 8, y: vp.y + 2 }); // step off
  b.onKey({ name: 'mousemove', mouse: true, x: 1, y: vp.y + b.st.railTicks[0].row });
  ok('far re-entry snaps the bulge', b.st.railBulge.v === b.st.railTicks[0].row);

  // moving off the rail (into the transcript) releases it
  b.onKey({ name: 'mousemove', mouse: true, x: RAIL_W + 8, y: vp.y + target.row });
  ok('leaving the rail clears hover', b.st.railHover === -1 && b.st.railAmt.target === 0);

  // a click jumps and fires the wiper rather than scrolling
  b.scrollTo(0);
  for (let i = 0; i < 6; i++) b.tick(1 / 30, i / 30, i);
  const tk = b.st.railTicks[5];
  b.onKey({ name: 'mousedown', mouse: true, x: 0, y: vp.y + tk.row });
  ok('click jumps the transcript', b.st.scrollTarget > 0);
  ok('jump snaps rather than easing', b.st.scrollSpring.v === b.st.scrollTarget);
  ok('jump fires the wiper', b.st.wipe > 0);
  ok('wiper sweeps forward on a forward jump', b.st.wipeDir === 1);

  // the wiper is a one-shot: it must park itself, not loop
  let sawMid = false;
  for (let i = 0; i < 40; i++) {
    b.tick(1 / 30, i / 30, i);
    if (b.st.wipe > 0.3 && b.st.wipe < 0.9) sawMid = true;
  }
  ok('wiper passes through mid-sweep', sawMid);
  ok('wiper parks when done', b.st.wipe === 0);

  // jumping backwards reverses the blade
  b.onKey({ name: 'mousedown', mouse: true, x: 0, y: vp.y + b.st.railTicks[0].row });
  ok('backward jump reverses the blade', b.st.wipeDir === -1);
  ok('backward jump lands at the top', b.st.scrollTarget === 0);

  // clicks off the rail are inert
  const scrollHeld = b.st.scrollTarget;
  b.onKey({ name: 'mousedown', mouse: true, x: 40, y: vp.y + 4 });
  ok('click in the transcript does nothing', b.st.scrollTarget === scrollHeld);

  // reduced motion keeps the jump but drops the sweep
  b.st.reduceMotion = true;
  b.st.wipe = 0;
  b.onKey({ name: 'mousedown', mouse: true, x: 0, y: vp.y + b.st.railTicks[4].row });
  ok('reduced motion still jumps', b.st.scrollTarget > 0);
  ok('reduced motion skips the wiper', b.st.wipe === 0);
  b.st.reduceMotion = false;

  // clearing the transcript must not leave a dangling hover
  b.onKey({ name: 'mousemove', mouse: true, x: 1, y: vp.y + b.st.railTicks[2].row });
  b.clearTranscript();
  ok('clear drops the hover', b.st.railHover === -1 && b.railHoverTick() === null);
  for (let i = 0; i < 10; i++) b.tick(1 / 30, i / 30, i);
  ok('empty rail renders', b.st.railTicks.length === 0);

  b.clock.stop();
  for (const id of b.timers) clearTimeout(id);
}

// ---- motion event decoding ----
{
  const mv = decode(Buffer.from('\x1b[<35;12;7M'));
  ok('hover motion decodes', mv.length === 1 && mv[0].name === 'mousemove');
  ok('motion carries 0-based coords', mv[0].x === 11 && mv[0].y === 6);
  const drag = decode(Buffer.from('\x1b[<32;5;5M'));
  ok('drag reports held motion', drag[0].name === 'mousedrag' && drag[0].dragging);
  // motion must not be confused with the wheel, which also sets a high bit
  ok('wheel still decodes past motion', decode(Buffer.from('\x1b[<64;1;1M'))[0].name === 'wheelup');
}


app.clock.stop();
for (const id of app.timers) clearTimeout(id);
process.stdout.columns = realCols;
process.stdout.rows = realRows;
