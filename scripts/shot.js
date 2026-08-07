// Render one frame to stdout as plain ANSI (no alt screen), for visual inspection.
// usage: node scripts/shot.js [splash|main|palette|slash|rail|wipe|settings|jump|table|toolgroup] [ms] [cols] [rows]

import { Screen } from '../src/screen.js';
import { App } from '../src/app.js';
import { drawSplash } from '../src/ui/splash.js';
import { settingsModel, settingsRows } from '../src/settings.js';
import { sgr, RESET, DEFAULT, charWidth } from '../src/ansi.js';
import { Spring } from '../src/anim.js';

const [which = 'main', msArg = '900', colsArg = '96', rowsArg = '30'] = process.argv.slice(2);
const cols = parseInt(colsArg, 10);
const rows = parseInt(rowsArg, 10);
const ms = parseInt(msArg, 10);

class FakeOut {
  constructor(w, h) { this.columns = w; this.rows = h; this.isTTY = true; }
  write() { return true; }
  on() {}
}

/** Serialize the cell buffer into printable ANSI lines. */
function dump(s) {
  let o = '';
  for (let y = 0; y < s.h; y++) {
    let fg = -2, bg = -2, at = 255;
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const ch = s.ch[i];
      if (ch === '') continue;
      if (s.fg[i] !== fg || s.bg[i] !== bg || s.at[i] !== at) {
        fg = s.fg[i]; bg = s.bg[i]; at = s.at[i];
        o += sgr(fg, bg, at);
      }
      o += ch === ' ' ? ' ' : ch;
    }
    o += `${RESET}\n`;
  }
  return o;
}

const app = new App({ noSplash: which !== 'splash' });
app.s = new Screen(new FakeOut(cols, rows));

if (which === 'splash') {
  drawSplash(app.s, ms);
} else if (which === 'slash') {
  app.seed();
  app.st.input = '/';
  app.refreshSlash();
  for (let i = 0; i < 8; i++) app.slashMove(1); // scroll down past the window
  for (let i = 0; i < 24; i++) app.tick(1 / 30, i / 30, i);
  app.render(2);
} else if (which === 'settings') {
  app.seed();
  app.openSettings();
  // park on a select row so the swatch + chevrons read in the grab
  const rows2 = settingsRows(settingsModel(app));
  const accent = rows2.findIndex((r) => r.key === 'accent');
  if (accent >= 0) app.st.settingsIndex = accent;
  app.st.settingsCursor.set(app.st.settingsIndex, true);
  for (let i = 0; i < Math.round(ms / 33); i++) app.tick(1 / 30, i / 30, i);
  app.render(ms / 1000);
} else if (which === 'table') {
  app.seed();
  app.push({
    role: 'approx',
    enter: 1,
    text: [
      '分层：',
      '',
      '| 层 | 职责 | 亮点 |',
      '| :--- | :--- | :--- |',
      '| `ansi.js` | 24-bit 颜色、SGR、display-width 表 | 完整的 CJK/emoji 宽度处理 |',
      '| `screen.js` | Cell-buffer 合成器与逐帧 diff | typed arrays，脏 cell 批量跑 SGR |',
      '| `theme.js` | 炼乳纸调色板与确定性纸张颗粒 | Math.imul 哈希而非 Math.random() |',
      '| `anim.js` | 临界阻尼弹簧与缓动函数 | 动画参数化且容易调试 |',
      '| `app.js` | 状态、键盘路由、update+render 循环 | 单 App 类，结构清晰 |',
    ].join('\n'),
  });
  for (let i = 0; i < Math.round(ms / 33); i++) app.tick(1 / 30, i / 30, i);
  app.render(ms / 1000);
} else if (which === 'toolgroup') {
  app.seed();
  const calls = [
    { callId: 'shot-1', name: 'find', title: 'Map project files', groupTitle: 'Audit rendering pipeline', modelGroupTitle: true, meta: 'src/**/*', text: 'src/app.js\nsrc/screen.js\nsrc/ui/transcript.js' },
    { callId: 'shot-2', name: 'read', title: 'Read compositor', meta: 'src/screen.js', text: 'cell buffer and diff flush inspected\nwide glyph tail handling verified' },
    { callId: 'shot-3', name: 'read', title: 'Read transcript renderer', meta: 'src/ui/transcript.js', text: 'message layout and folded tool rows inspected' },
    { callId: 'shot-4', name: 'grep', title: 'Trace tool routing', meta: '8 matches', text: 'tool_start → beginLiveTool\ntool_end → finishLiveTool' },
  ];
  for (const call of calls) {
    const tool = app.push({
      role: 'tool', ...call, running: false, expanded: false,
      expandAnim: new Spring(0, { stiff: 18, damp: 0.86 }),
    });
    tool.isError = false;
  }
  const group = app.st.msgs.find((msg) => msg.role === 'toolgroup');
  if (group) {
    group.expanded = true;
    group.expandAnim.set(1, true);
    group.tools[1].expanded = true;
    group.tools[1].expandAnim.set(1, true);
  }
  for (let i = 0; i < Math.round(ms / 33); i++) app.tick(1 / 30, i / 30, i);
  app.render(ms / 1000);
} else if (which === 'jump') {
  app.seed();
  for (let i = 0; i < 9; i++)
    app.push({
      role: i % 2 ? 'approx' : 'user',
      text: [
        'how does the compositor avoid full repaints',
        'it diffs parallel cell arrays and only flushes what changed',
        'what about wide glyphs shearing at the edge',
        'the trailing column is reserved so nothing tears',
        'walk me through the spring model',
        'critically damped, wall-clock delta, no frame assumptions',
        'can a driver push frames over stdin',
        'yes, the harness speaks newline-delimited json',
        'nice, that keeps the runtime decoupled',
      ][i],
      enter: 1,
    });
  app.openJump();
  app.st.jumpQuery = 'compositor';
  app.refreshJump();
  app.st.jumpIndex = 0;
  app.clampJumpScroll();
  for (let i = 0; i < Math.round(ms / 33); i++) app.tick(1 / 30, i / 30, i);
  app.render(ms / 1000);
} else {
  app.seed();
  app.push({ role: 'user', text: 'explain how the compositor avoids full repaints' });
  const m = app.beginStream(
    'The renderer keeps two cell buffers and compares them per cell.\n\n' +
    '- glyph, fg, bg, and attributes are stored in parallel arrays\n' +
    '- runs sharing a style collapse into a single SGR write\n' +
    '- wide glyphs reserve their trailing column so nothing shears\n\n' +
    '```js\nif (cell.same(prev)) continue;\n```\n\n' +
    'A shimmer touching twelve cells costs twelve cells, not a screen.'
  );
  app.push({ role: 'tool', name: 'measure', meta: 'frame budget', text: 'dirty cells/frame  avg 41  peak 388\nflush 0.21ms avg', running: true, progress: 0.62, enter: 1 });
  app.st.input = which === 'palette' ? '' : '/th';
  app.refreshSlash();
  // settle the animation so the frame reads as steady-state
  for (let i = 0; i < Math.round(ms / 33); i++) app.tick(1 / 30, i / 30, i);
  if (which === 'rail' || which === 'wipe') {
    app.st.input = '';
    app.refreshSlash();
    // park the pointer on the second tick, then let the bulge spring settle
    app.render(1); // populate railTicks before hit-testing against them
    const tk = app.st.railTicks[1] ?? app.st.railTicks[0];
    if (tk) app.railHoverAt(1, app.viewport().y + tk.row);
    for (let i = 0; i < 20; i++) app.tick(1 / 30, i / 30, i);
    if (which === 'wipe') {
      if (tk) app.jumpToMessage(tk.index);
      app.st.wipe = 0.55; // mid-sweep
    }
  }
  if (which === 'palette') {
    app.openPalette();
    app.st.paletteQuery = 'the';
    app.paletteRefilter();
    for (let i = 0; i < 24; i++) app.tick(1 / 30, i / 30, i);
  }
  app.render(ms / 1000);
}

process.stdout.write(dump(app.s));
app.clock.stop();
for (const id of app.timers) clearTimeout(id);
process.exit(0);
