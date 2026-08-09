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
{
  const tuiOut = new FakeOut();
  enterTui(tuiOut);
  ok('TUI exposes a steady native cursor for Windows IME', tuiOut.buf.includes(SHOW_CURSOR + CURSOR_STEADY_BAR));
}

// IME preedit does not produce Node key events. The idle clock must therefore
// leave the terminal untouched until a real input/backend/resize event arrives.
{
  const imeApp = new App({ noSplash: true });
  const imeOut = new FakeOut(80, 24);
  imeApp.s = new Screen(imeOut);
  imeApp.tick(1 / 60, 0, 0);
  const idleStart = imeOut.buf.length;
  for (let i = 1; i <= 12; i++) imeApp.tick(1 / 60, i / 60, i);
  ok('idle composer does not repaint during IME preedit', imeOut.buf.length === idleStart);
  imeApp.onKey({ name: 'x', printable: true });
  imeApp.tick(1 / 60, 13 / 60, 13);
  ok('committed key requests a composer frame', imeOut.buf.length > idleStart && imeApp.st.input === 'x');
  imeApp.st.busy = true;
  const busyStart = imeOut.buf.length;
  for (let i = 14; i <= 25; i++) imeApp.tick(1 / 60, i / 60, i);
  ok('busy clock does not repaint over queued IME input', imeOut.buf.length === busyStart);
  imeApp.onBackendEvent({ type: 'assistant_delta', delta: 'live' });
  imeApp.tick(1 / 60, 26 / 60, 26);
  ok('backend activity requests a live frame', imeOut.buf.length > busyStart);
  imeApp.clock.stop();
}

// ---- ansi / width ----
ok('rgb hex', rgb('#F7EEDD') === 0xf7eedd);
ok('rgb short hex', rgb('#fff') === 0xffffff);
ok('mix endpoints', mix(0x000000, 0xffffff, 1) === 0xffffff && mix(0x000000, 0xffffff, 0) === 0);
ok('width ascii', strWidth('hello') === 5);
ok('width cjk', strWidth('豚鼠娘') === 6);
ok('width mixed', strWidth('a豚b') === 4);

// ---- wrapping ----
const wr = wrapText('the quick brown fox jumps over the lazy dog', 12);
ok('wrap respects width', wr.every((l) => strWidth(l) <= 12));
ok('wrap keeps all words', wr.join(' ').split(/\s+/).length === 9);
const cjk = wrapText('豚鼠娘社区激活机器人正在运行中', 8);
ok('wrap cjk width', cjk.every((l) => strWidth(l) <= 8));
ok('wrap newline', wrapText('a\n\nb', 10).length === 3);
ok('wrap long token', wrapText('x'.repeat(30), 10).every((l) => l.length <= 10));
ok('ellipsize', ellipsize('abcdefghij', 5) === 'abcd…');
ok('padTo exact', strWidth(padTo('ab', 6)) === 6);
ok('padTo center', padTo('ab', 6, 'center') === '  ab  ');

// ---- input decoding ----
const d1 = decode(Buffer.from('\x1b[A'));
ok('decode up', d1.length === 1 && d1[0].name === 'up');
const d2 = decode(Buffer.from('\x03'));
ok('decode ctrl-c', d2[0].ctrl && d2[0].name === 'c');
const d3 = decode(Buffer.from('\r'));
ok('decode enter', d3[0].name === 'enter');
const d4 = decode(Buffer.from('hi'));
ok('decode printable', d4.length === 2 && d4[0].printable && d4[0].name === 'h');
const d5 = decode(Buffer.from('\x1b[5~'));
ok('decode pageup', d5[0].name === 'pageup');
const d6 = decode(Buffer.from('豚'));
ok('decode multibyte', d6.length === 1 && d6[0].name === '豚');
const d7 = decode(Buffer.from('\x1b[1;5C'));
ok('decode ctrl-right', d7[0].name === 'right' && d7[0].ctrl);
const d8 = decode(Buffer.from('\x7f'));
ok('decode backspace', d8[0].name === 'backspace');
ok('focus reporting decodes as control', decode(Buffer.from('\x1b[I'))[0].name === 'focusin'
  && decode(Buffer.from('\x1b[O'))[0].name === 'focusout');
ok('osc52 clipboard encodes utf8', clipboardSequence('复制').includes(Buffer.from('复制').toString('base64')));

// stdin may split ESC, CSI and the SGR payload into separate chunks on focus.
// The stateful attachment must reassemble them instead of typing "<35;…M".
{
  class FakeIn extends EventEmitter {
    constructor() { super(); this.isTTY = true; }
    setRawMode() {}
    resume() {}
    pause() {}
  }
  const input = new FakeIn();
  const events = [];
  const detach = attach((event) => events.push(event), input);
  input.emit('data', Buffer.from('\x1b'));
  input.emit('data', Buffer.from('[<35;51;17'));
  input.emit('data', Buffer.from('M'));
  input.emit('data', Buffer.from('\x1b['));
  input.emit('data', Buffer.from('I'));
  detach();
  ok('split sgr mouse frame is reassembled', events.some((event) => event.name === 'mousemove')
    && !events.some((event) => event.printable));
  ok('split focus sequence is swallowed as control', events.at(-1)?.name === 'focusin');
}

{
  const focusApp = new App();
  focusApp.onKey({ name: 'focusin' });
  focusApp.onKey({ name: 'focusout' });
  ok('focus controls never leak into input or skip splash', focusApp.st.phase === 'splash' && focusApp.st.input === '');
  focusApp.clock.stop();
}

// ---- animation ----
const sp = new Spring(0, { stiff: 14, damp: 1 });
sp.set(10);
for (let i = 0; i < 400; i++) sp.step(1 / 60);
ok('spring converges', Math.abs(sp.v - 10) < 0.01 && sp.settled);
const stalled = new Spring(0, { stiff: 18, damp: 1.12 });
stalled.set(100);
stalled.step(0.25);
ok('spring stays finite after a stalled frame', Number.isFinite(stalled.v) && stalled.v >= 0 && stalled.v <= 100);
const tw = new Tween({ from: 0, to: 1, dur: 100 });
tw.step(0.2);
ok('tween completes', tw.done && tw.value === 1);
ok('ease bounds', ease.outCubic(0) === 0 && Math.abs(ease.outCubic(1) - 1) < 1e-9);
ok('ease outExpo clamped', ease.outExpo(1) === 1);
ok('clamp', clamp(5, 0, 1) === 1 && clamp(-5, 0, 1) === 0);

// ---- screen compositor ----
const out = new FakeOut(80, 24);
const s = new Screen(out);
ok('screen size', s.w === 80 && s.h === 24);
ok('paper background is uniform across cells', paper(0, 0) === paper(1, 0) && paper(3, 7) === T.bg);
s.clear(T.bg, T.fg, paper);
s.text(0, 0, 'HELLO', T.fg, T.bg);
s.flush();
ok('first flush writes', out.buf.includes('H') && out.buf.length > 50);
const before = out.buf.length;
s.flush();
ok('idempotent flush is empty', out.buf.length === before);
s.text(0, 0, 'HELLP', T.fg, T.bg);
s.flush();
const delta = out.buf.length - before;
ok('diff flush stays bounded with synchronized framing', delta > 0 && delta < 100);

// Windows IME preedit follows the hidden terminal cursor. Every animated diff
// must finish back at the editor caret instead of leaving it at the changed cell.
const anchorStart = out.buf.length;
s.setCursorAnchor(7, 5);
s.flush();
ok('cursor anchor moves and restores the native caret without a cell diff',
  out.buf.slice(anchorStart) === moveTo(7, 5) + SHOW_CURSOR + CURSOR_STEADY_BAR);
const animatedStart = out.buf.length;
s.put(70, 20, 'X', T.accent, T.bg);
s.flush();
const animatedFrame = out.buf.slice(animatedStart);
ok('animated diff preserves IME cursor without an absolute jump', animatedFrame.startsWith(SYNC_START + SAVE_CURSOR)
  && animatedFrame.endsWith(RESTORE_CURSOR + SYNC_END));
const anchoredLength = out.buf.length;
s.flush();
ok('stable cursor anchor emits no redundant write', out.buf.length === anchoredLength);
const modalCursorStart = out.buf.length;
s.clearCursorAnchor();
s.flush();
ok('frames without an editor anchor hide the native caret', out.buf.slice(modalCursorStart) === HIDE_CURSOR);

// wide glyph reserves the next cell
s.clear(T.bg, T.fg, null);
s.put(3, 3, '豚', T.fg, T.bg);
ok('wide glyph reserves', s.ch[3 * 80 + 4] === '');
// Reusing either half in the same frame must repair the pair. This is the path
// hit by a streaming caret moving through Chinese text.
s.put(4, 3, 'A', T.fg, T.bg);
ok('overwrite wide tail clears old head', s.ch[3 * 80 + 3] === ' ' && s.ch[3 * 80 + 4] === 'A');
s.put(8, 3, '鼠', T.fg, T.bg);
s.put(8, 3, 'B', T.fg, T.bg);
ok('overwrite wide head releases tail', s.ch[3 * 80 + 8] === 'B' && s.ch[3 * 80 + 9] === ' ');
// A real stream repaints a growing prefix and moves a block caret each frame.
s.clear(T.bg, T.fg, null);
s.text(0, 4, '中文渲染', T.fg, T.bg);
s.put(8, 4, '█', T.fg, T.bg);
s.flush();
s.clear(T.bg, T.fg, null);
s.text(0, 4, '中文渲染正常', T.fg, T.bg);
s.put(12, 4, '█', T.fg, T.bg);
s.flush();
ok('wide stream syncs previous frame tails', s.ch.every((ch, i) => ch === s.pch[i]));

// Paper texture is now a foreground layer. A wide glyph must erase both speck
// cells and force its reserved tail to exactly match the head style.
s.clear(T.bg, T.fg);
drawPaperGrain(s);
ok('paper grain still draws sparse texture', s.ch.some((ch) => ch === '·'));
const grainCell = s.ch.findIndex((ch) => ch === '·');
ok('paper grain has no clipboard character', s.copyCh[grainCell] === ' ');
s.put(grainCell % s.w, Math.floor(grainCell / s.w), '·', T.fg, T.bg);
ok('a real middle dot remains copyable', s.copyCh[grainCell] === '·');
s.put(11, 6, '中');
const wideHead = 6 * s.w + 11;
ok('grain cannot survive under wide tail', s.ch[wideHead + 1] === '');
ok('wide head and tail styles match', s.fg[wideHead] === s.fg[wideHead + 1] && s.bg[wideHead] === s.bg[wideHead + 1]);
s.tint(12, 6, 0x123456, 0x654321);
ok('tinting wide tail updates both columns', s.fg[wideHead] === 0x123456 && s.fg[wideHead + 1] === 0x123456
  && s.bg[wideHead] === 0x654321 && s.bg[wideHead + 1] === 0x654321);

// out-of-bounds writes are dropped, not thrown
let threw = false;
try {
  s.put(-5, -5, 'x');
  s.put(9999, 9999, 'x');
  s.text(78, 5, 'overflowing text past the edge', T.fg);
} catch {
  threw = true;
}
ok('bounds safe', !threw);

// Composer follows the active theme in both Plan and Go, including the hard
// offset shadow. Go must not fall back to a fixed teal tone.
{
  const cs = new Screen(new FakeOut(42, 10));
  cs.clear(T.bg, T.fg);
  const composerState = {
    input: 'test', busy: false, focusAnim: { v: 1 }, slashMatches: [], plan: { mode: 'plan' },
  };
  drawComposer(cs, composerState, 1, 2, 38, 0);
  const borderCell = 2 * cs.w + 1;
  const shadowCell = 5 * cs.w + 2;
  ok('Plan composer uses Plan signal', cs.fg[borderCell] === T.accent
    && cs.bg[shadowCell] === mix(T.bg, T.accent, 0.2));
  composerState.plan.mode = 'go';
  drawComposer(cs, composerState, 1, 2, 38, 0);
  ok('Plan to Go keeps composer on the active theme', cs.fg[borderCell] === T.accent
    && cs.bg[shadowCell] === mix(T.bg, T.accent, 0.2));

  const emptyState = {
    input: '', inputCursor: 0, _cursorInput: '', busy: false,
    focusAnim: { v: 1 }, slashMatches: [], plan: { mode: 'go' },
  };
  cs.clear(T.bg, T.fg);
  drawComposer(cs, emptyState, 1, 2, 38, 0);
  const idleChars = cs.ch.join('');
  const idleFg = Array.from(cs.fg);
  cs.clear(T.bg, T.fg);
  drawComposer(cs, emptyState, 1, 2, 38, 3.7);
  ok('empty composer leaves a clean IME preedit row', !idleChars.includes('ask anything'));
  ok('idle composer caret and prompt are time-stable', cs.ch.join('') === idleChars
    && idleFg.every((color, index) => color === cs.fg[index]));
}

// Editable wrapping must preserve trailing whitespace and the actual cursor.
{
  const state = { input: '', inputCursor: 0, _cursorInput: '' };
  insertComposerText(state, '中文 ');
  const laid = layoutComposerInput(state.input, 20, state.inputCursor);
  ok('composer keeps a trailing space visible', laid.lines[0] === '中文 ' && laid.cursorCol === 5);
  moveComposerCursor(state, -2);
  insertComposerText(state, 'A');
  ok('composer inserts at the horizontal cursor', state.input === '中A文 ' && state.inputCursor === 2);

  const app = new App({ noSplash: true });
  setComposerInput(app.st, '甲乙');
  app.onKey({ name: 'left' });
  app.onKey({ name: 'space' });
  app.onKey({ name: 'left' });
  app.onKey({ name: 'right' });
  ok('left/right keys edit around CJK characters', app.st.input === '甲 乙' && app.st.inputCursor === 2);
  app.clock.stop();
}

{
  const app = new App({ noSplash: true });
  app.s = new Screen(new FakeOut(70, 18));
  for (let i = 0; i < 80; i++) app.push({ role: 'approx', text: `row ${i} ${SAMPLE_LONG}`, enter: 1 });
  app.scrollTo(0);
  app.st.scrollSpring.set(0, true);
  for (let i = 0; i < 60; i++) app.scrollBy(i % 3 === 0 ? -3 : 3);
  app.update(0.25, 1);
  ok('violent wheel bursts stay inside document bounds', Number.isFinite(app.st.scroll)
    && app.st.scroll >= 0 && app.st.scroll <= app.maxScroll());
  app.clock.stop();
}
