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
// ---- splash renders across its whole timeline ----
const s = new Screen(new FakeOut(80, 24));
let splashThrew = null;
try {
  for (let ms = 0; ms <= SPLASH_MS + 60; ms += 17) drawSplash(s, ms);
} catch (e) {
  splashThrew = e;
}
ok('splash renders', !splashThrew);
recordError('splash', splashThrew);
ok('splash terminates', drawSplash(s, SPLASH_MS + 1) === 1);

// tiny terminal must not crash the splash
const tiny = new Screen(new FakeOut(24, 9));
let tinyThrew = null;
try {
  for (let ms = 0; ms <= SPLASH_MS; ms += 120) drawSplash(tiny, ms);
} catch (e) {
  tinyThrew = e;
}
ok('splash survives tiny term', !tinyThrew);

// ---- fuzzy / palette ----
ok('fuzzy subsequence', fuzzy('clr', 'clear') !== null);
ok('fuzzy rejects', fuzzy('zzz', 'clear') === null);
ok('fuzzy prefers prefix', fuzzy('cl', 'clear').score > fuzzy('ar', 'clear').score);
const cmds = [
  { name: 'clear', desc: 'wipe' },
  { name: 'quit', desc: 'exit' },
];
ok('filter finds', filterCommands(cmds, 'cl').length === 1);
ok('filter empty query returns all', filterCommands(cmds, '').length === 2);
ok('theme exposes concrete overlay colours', ['cream', 'crust', 'milk', 'ink', 'sand', 'ember'].every((key) => Number.isInteger(T[key]) && T[key] > 0));
const unicodeHit = fuzzy('模切', '模型切换');
ok('fuzzy hit offsets use unicode characters', unicodeHit?.hits.has(0) && unicodeHit?.hits.has(2));

// Palette geometry and actual cell colours are regression-tested together.
// Missing theme keys used to be coerced to RGB 0 by mix(), producing a valid
// frame with a giant black list body — a crash-only smoke test could not see it.
{
  const ps = new Screen(new FakeOut(80, 24));
  ps.clear(T.bg, T.fg);
  drawPaperGrain(ps);
  ps.text(25, 10, '面板下方的中文', T.fg, T.bg);
  const results = filterCommands([
    { name: 'help', desc: 'Show keys and commands', key: '?' },
    { name: 'clear', desc: 'Start a clean context', key: '^l' },
    { name: 'model', desc: 'Switch model', key: '' },
    { name: 'effort', desc: 'Switch reasoning effort', key: '' },
    { name: 'markdown', desc: 'Render Markdown on/off', key: '' },
    { name: 'settings', desc: 'Open the settings page', key: '^o' },
    { name: 'quit', desc: 'Exit Approx', key: '^c' },
    { name: 'bottom', desc: 'Jump to the newest', key: 'G' },
    { name: 'theme', desc: 'Cycle accent colour', key: '^t' },
  ], '');
  const pst = {
    paletteAnim: { v: 1 }, paletteResults: results, paletteScroll: 0,
    paletteIndex: 0, paletteQuery: '',
  };
  const untouchedX = paletteLayout(ps.w, ps.h, results.length).px - 2;
  const untouchedY = paletteLayout(ps.w, ps.h, results.length).py + 4;
  ps.put(untouchedX, untouchedY, 'X', T.fg, T.bg);
  const beforePalette = paletteLayout(ps.w, ps.h, results.length);
  const crossingY = beforePalette.resultY + 2;
  // Force CJK glyphs to straddle both sides of the one-cell halo. Overlay fills
  // must clear them without leaking the halo background one extra cell outward.
  ps.put(beforePalette.px - 2, crossingY, '左', T.fg, T.bg);
  ps.put(beforePalette.px + beforePalette.pw, crossingY, '右', T.fg, T.bg);
  drawPalette(ps, pst, 1);
  const g = paletteLayout(ps.w, ps.h, results.length);
  const cell = (x, y) => y * ps.w + x;
  ok('palette selected row is intentionally inverted', ps.bg[cell(g.px + 3, g.resultY)] === T.fg);
  ok('palette ordinary rows keep panel background', ps.bg[cell(g.px + 3, g.resultY + 1)] === T.panel);
  ok('palette panel never contains accidental pure black', (() => {
    for (let y = g.py; y < g.py + g.ph; y++) {
      for (let x = g.px; x < g.px + g.pw; x++) if (ps.bg[cell(x, y)] === 0) return false;
    }
    return true;
  })());
  ok('palette command name remains visible', ps.ch.slice(cell(g.px + 4, g.resultY), cell(g.px + 8, g.resultY)).join('') === 'help');
  ok('palette no longer clears an outer backdrop', ps.ch[cell(untouchedX, untouchedY)] === 'X');
  ok('palette keeps only a one-cell safety halo', ps.ch[cell(g.px - 1, g.resultY)] === ' ');
  const scrimBg = mix(T.bg, T.shadow, 0.35);
  ok('palette left edge does not grow a CJK tooth', ps.bg[cell(g.px - 2, crossingY)] === scrimBg
    && ps.bg[cell(g.px - 1, crossingY)] === T.bg);
  ok('palette right edge does not grow a CJK tooth', ps.bg[cell(g.px + g.pw, crossingY)] === T.bg
    && ps.bg[cell(g.px + g.pw + 1, crossingY)] === scrimBg);

  const small = paletteLayout(24, 9, 18);
  ok('palette shrinks rows to terminal height', small.ph <= 9 && small.rows === 3 && small.py >= 0);
  let smallThrew = false;
  try {
    const ss = new Screen(new FakeOut(24, 9));
    ss.clear(T.bg, T.fg);
    drawPalette(ss, pst, 1);
  } catch {
    smallThrew = true;
  }
  ok('palette renders in a narrow terminal', !smallThrew);
}

// Jump uses the same clipped overlay plate: its two-cell hard shadow must not
// carry the cream background through a CJK glyph on the right edge.
{
  const js = new Screen(new FakeOut(80, 24));
  js.clear(T.bg, T.fg);
  const messages = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'tool' : 'approx', text: `消息 ${i}` }));
  const results = messages.map((msg, index) => ({ msg, index }));
  const jst = {
    jumpAnim: { v: 1 }, jumpResults: results, jumpScroll: 0,
    jumpIndex: 0, jumpQuery: '',
  };
  const g = jumpLayout(js.w, js.h, results.length, 1);
  const crossingY = g.py;
  const panelLast = g.px + g.pw - 1;
  js.put(panelLast, crossingY, '右', T.fg, T.bg);
  drawJumpList(js, jst, 1);
  const cell = (x, y) => y * js.w + x;
  const scrimBg = mix(T.bg, T.shadow, 0.32);
  const shadowBg = mix(T.bg, T.shadow, 0.34);
  ok('jump right edge does not grow a CJK tooth', js.bg[cell(panelLast + 1, crossingY)] === scrimBg);
  ok('jump has one hard shadow and no pale safety layer', js.bg[cell(panelLast + 1, g.py + 2)] === shadowBg
    && js.bg[cell(panelLast + 1, g.py)] === scrimBg);
}

// ---- transcript layout ----
const m = { role: 'approx', text: '# Head\n- one\n- two\n\nbody text here', enter: 1 };
const ls = layout(m, 40);
ok('layout heading', ls[0].kind === 'h');
ok('layout list items', ls.filter((l) => l.kind === 'li').length === 2);
ok('layout caches', layout(m, 40) === ls);
ok('layout recomputes on resize', layout(m, 30) !== ls);
ok('totalHeight positive', totalHeight([m], 40) > 4);
const md = { role: 'approx', text: '### 工具\n1. **读取** `file.js`\n> 完成', enter: 1 };
const mdLines = layout(md, 40);
ok('markdown strips syntax', !mdLines.some((line) => /\*\*|```|###/.test(line.text)));
ok('markdown ordered list', mdLines.some((line) => line.kind === 'li' && line.marker === '1.'));
ok('markdown inline styles', mdLines.some((line) => line.runs?.some((run) => run.attrs || run.code)));
md.markdown = false;
md._lines = null;
ok('markdown can be disabled', layout(md, 40).some((line) => line.text.includes('###')));

const tableSource = [
  '| 层 | 职责 | 亮点 |',
  '| :--- | :---: | ---: |',
  '| `ansi.js` | 颜色\\|SGR | 完整的 **CJK/emoji** 宽度处理 |',
  '| screen.js | 合成器 | `a|b` 和逐帧 diff |',
  '| app.js | 状态与键盘路由 | 结构清晰 |',
].join('\n');
const tableMsg = { role: 'approx', text: tableSource, enter: 1 };
const tableLines = layout(tableMsg, 56);
ok('markdown table emits terminal rules', tableLines.filter((line) => line.kind === 'tableRule').length === 3);
ok('markdown table styles its header', tableLines.some((line) => line.kind === 'tableHead'));
ok('markdown table removes delimiter source', !tableLines.some((line) => /:---/.test(line.text)));
ok('markdown table keeps escaped and code pipes inside cells', tableLines.some((line) => line.kind === 'tableRow' && line.text.includes('颜色|SGR'))
  && tableLines.some((line) => line.kind === 'tableRow' && line.text.includes('a|b')));
ok('markdown table preserves inline code and emphasis', tableLines.some((line) => line.runs?.some((run) => run.code))
  && tableLines.some((line) => line.runs?.some((run) => run.attrs)));
ok('markdown table respects display width', tableLines.every((line) => strWidth(line.text) <= 53));
ok('markdown table wraps long CJK cells', tableLines.filter((line) => line.kind === 'tableRow').length >= 3);

// A fullwidth punctuation glyph owns two cells; changing the background at the
// following inline-code run must not erase its head or paint its reserved tail.
{
  const screen = new Screen(new FakeOut(80, 12));
  screen.clear();
  drawTranscript(screen, [{ role: 'approx', text: '- **巨型**：50k+（`helix`、`lazygit` + 插件生态）', enter: 1 }], 0, 0, 80, 12, 0, 0);
  const visible = screen.ch.filter((cell) => cell !== '').join('');
  ok('fullwidth punctuation survives inline-code style boundary', visible.includes('（helix、lazygit'));

  const codeScreen = new Screen(new FakeOut(80, 12));
  codeScreen.clear();
  drawTranscript(codeScreen, [{ role: 'approx', text: 'inspect `screen.js` now', enter: 1 }], 0, 0, 80, 12, 0, 0);
  const codeCell = codeScreen.ch.findIndex((cell) => cell === 's');
  ok('inline code has no black background chip', codeCell >= 0 && codeScreen.bg[codeCell] !== 0x000000);
}

const narrowTable = { role: 'approx', text: tableSource, enter: 1 };
const narrowTableLines = layout(narrowTable, 12);
ok('markdown table stacks at extreme width', narrowTableLines.some((line) => line.tableStack)
  && !narrowTableLines.some((line) => line.kind === 'tableRule'));
ok('stacked table remains width safe', narrowTableLines.every((line) => strWidth(line.text) <= 9));

const literalTable = { role: 'approx', text: tableSource, markdown: false, enter: 1 };
ok('markdown off leaves table source literal', layout(literalTable, 56).some((line) => line.text.includes('| :---')));
