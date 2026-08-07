// Headless smoke test: drives the real render path against a fake TTY and
// asserts the compositor, wrapping, input decoder, and animation core behave.

import { Screen } from '../src/screen.js';
import { attach, decode } from '../src/input.js';
import { wrapText, ellipsize, padTo } from '../src/wrap.js';
import { strWidth, rgb, mix, clipboardSequence } from '../src/ansi.js';
import { Spring, Tween, ease, clamp } from '../src/anim.js';
import { drawSplash, SPLASH_MS } from '../src/ui/splash.js';
import { drawPalette, fuzzy, filterCommands, paletteLayout } from '../src/ui/palette.js';
import { drawTranscript, layout, totalHeight, visibleLines } from '../src/ui/transcript.js';
import { drawGit } from '../src/ui/git.js';
import { buildFileChanges } from '../src/file-changes.js';
import { parseGitStatus } from '../src/git.js';
import { railTicks, tickAtRow, tickLabel, RAIL_W } from '../src/ui/rail.js';
import { settingsModel, settingsRows, applySetting } from '../src/settings.js';
import { drawJumpList, jumpResults, jumpLabel, jumpLayout, logicalTimeline } from '../src/ui/jumplist.js';
import { drawComposer } from '../src/ui/composer.js';
import { drawCompact } from '../src/ui/compact.js';
import { drawPlanPanel } from '../src/ui/plan.js';
import {
  layoutComposerInput, setComposerInput, insertComposerText, moveComposerCursor,
} from '../src/composer-state.js';
import {
  applyPlanOperation, buildPlanTurnInjection, createPlanState, serializePlanState,
} from '../src/plan.js';
import { createApproxHostTools } from '../src/pi-host-tools.js';
import { loadPreferences, savePreferences } from '../src/persistence.js';
import { Harness } from '../src/harness.js';
import { App } from '../src/app.js';
import { createAppState } from '../src/app-state.js';
import { PiBackend } from '../src/backends/pi.js';
import { toolMessages } from '../src/message-tree.js';
import { T, paper, drawPaperGrain } from '../src/theme.js';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAMPLE_LONG = 'The renderer keeps two cell buffers and compares them per cell. '.repeat(6);

let pass = 0;
const fails = [];
const ok = (name, cond) => {
  if (cond) pass++;
  else fails.push(name);
};

// ---- fake stdout that records writes ----
class FakeOut {
  constructor(w = 100, h = 32) {
    this.columns = w;
    this.rows = h;
    this.isTTY = true;
    this.buf = '';
    this.writes = 0;
  }
  write(s) {
    this.buf += s;
    this.writes++;
    return true;
  }
  on() {}
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
ok('diff flush is small', delta > 0 && delta < 60);

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

// Composer mode color is red for Plan and returns to teal for Go on the next
// frame, including the hard offset shadow.
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
  ok('Plan to Go restores composer color', cs.fg[borderCell] === T.accent2
    && cs.bg[shadowCell] === mix(T.bg, T.accent2, 0.2));
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

// ---- editable Plan workflow ----
{
  const state = createPlanState({
    mode: 'plan',
    proposal: 'Ship a cohesive editing workflow.',
    approval: 'approved',
    todos: [
      { id: 'one', text: 'First step', comment: 'Preserve the public API.' },
      { id: 'two', text: 'Second step' },
      { id: 'three', text: 'Third step' },
    ],
  });
  const revision = state.revision;
  applyPlanOperation(state, { action: 'move_todo', id: 'three', offset: -2, source: 'user' });
  ok('Plan operation reorders Todos and follows the moved cursor', state.todos.map((todo) => todo.id).join(',') === 'three,one,two'
    && state.cursor === 0 && state.revision === revision + 1 && state.approval === 'pending');
  applyPlanOperation(state, {
    action: 'update_todo', id: 'three', text: 'Rewritten step', note: 'Verify both modes.', source: 'user',
  });
  applyPlanOperation(state, { action: 'remove_todo', id: 'one', source: 'user' });
  applyPlanOperation(state, { action: 'add_todo', text: 'Added step', source: 'user' });
  ok('Plan operations add edit and delete Todos', state.todos.length === 3
    && state.todos[0].text === 'Rewritten step'
    && state.todos[0].note === 'Verify both modes.'
    && !state.todos.some((todo) => todo.id === 'one')
    && state.todos.at(-1).text === 'Added step');
  const snapshot = serializePlanState(state);
  ok('Todo notes normalize and serialize', snapshot.todos[0].note === 'Verify both modes.'
    && snapshot.todos.every((todo) => Object.hasOwn(todo, 'note')));
  ok('Todo notes reach the agent Plan context', buildPlanTurnInjection(state).includes('note: Verify both modes.'));

  const updatePlanTool = createApproxHostTools({}).find((tool) => tool.name === 'update_plan');
  ok('Pi update_plan accepts Todo notes', updatePlanTool.parameters.properties.note
    && updatePlanTool.parameters.properties.todos.items.properties.note);
}

{
  const planApp = new App({ noSplash: true });
  planApp.s = new Screen(new FakeOut(86, 24));
  planApp.st.plan = createPlanState({
    mode: 'plan',
    intent: 'Original summary',
    proposal: 'Original approach',
    approval: 'approved',
    todos: [
      { id: 'first', text: 'First Todo' },
      { id: 'second', text: 'Second Todo' },
    ],
  });
  planApp.focusPlan();

  planApp.planKey({ name: 'a' });
  ok('Plan A opens the shared text questionnaire', planApp.st.questionnaire.open
    && planApp.st.questionnaire.title === 'ADD TODO');
  planApp.setQuestionnaireAnswer('todo-text', 'Third Todo');
  planApp.setQuestionnaireAnswer('todo-note', 'Check keyboard and pointer paths.');
  planApp.finishQuestionnaire();
  await Promise.resolve();
  ok('Plan add questionnaire appends and selects a Todo', planApp.st.plan.todos.at(-1)?.text === 'Third Todo'
    && planApp.st.plan.todos.at(-1)?.note === 'Check keyboard and pointer paths.'
    && planApp.st.plan.cursor === 2 && planApp.st.plan.approval === 'pending');

  planApp.planKey({ name: 'e' });
  planApp.setQuestionnaireAnswer('todo-text', 'Edited Third Todo');
  planApp.setQuestionnaireAnswer('todo-note', 'Updated Todo note.');
  planApp.finishQuestionnaire();
  await Promise.resolve();
  ok('Plan E edits Todo text and note', planApp.st.plan.todos[2]?.text === 'Edited Third Todo'
    && planApp.st.plan.todos[2]?.note === 'Updated Todo note.');

  planApp.planKey({ name: 'up', shift: true });
  ok('Plan shift-arrow reorders the selected Todo', planApp.st.plan.cursor === 1
    && planApp.st.plan.todos[1]?.text === 'Edited Third Todo');

  planApp.planKey({ name: 'p' });
  ok('Plan P opens summary and approach editing', planApp.st.questionnaire.open
    && planApp.st.questionnaire.questions.length === 2);
  planApp.setQuestionnaireAnswer('intent', 'Revised summary');
  planApp.setQuestionnaireAnswer('proposal', 'Revised approach');
  planApp.finishQuestionnaire();
  await Promise.resolve();
  ok('Plan overview editor commits both fields', planApp.st.plan.intent === 'Revised summary'
    && planApp.st.plan.proposal === 'Revised approach');

  planApp.planKey({ name: 'd' });
  ok('Plan D deletes the selected Todo and keeps a valid cursor', planApp.st.plan.todos.length === 2
    && !planApp.st.plan.todos.some((todo) => todo.text === 'Edited Third Todo')
    && planApp.st.plan.cursor === 1);

  planApp.st.plan.todos = Array.from({ length: 9 }, (_, i) => ({
    id: `visible-${i + 1}`, text: `Visible Todo ${i + 1}`,
    note: i === 8 ? 'This Todo has context.' : '', status: 'pending',
  }));
  planApp.st.plan.cursor = 8;
  planApp.s.clear(T.bg, T.fg);
  drawPlanPanel(planApp.s, planApp.st, 1, 1, 82, 0, 20);
  ok('Plan panel scrolls its Todo window with the cursor', planApp.st.plan.hits.some((hit) => hit.id === 'visible-9'));
  ok('Plan panel marks Todos with notes', planApp.s.ch.join('').includes(' NOTE '));
  ok('Plan panel exposes editing click targets', ['summary', 'add', 'edit', 'delete'].every((kind) =>
    planApp.st.plan.hits.some((hit) => hit.kind === kind)));
  const addHit = planApp.st.plan.hits.find((hit) => hit.kind === 'add');
  planApp.planPointer(addHit.x1, addHit.y, true);
  ok('Plan editing toolbar is clickable', planApp.st.questionnaire.open
    && planApp.st.questionnaire.title === 'ADD TODO');
  planApp.cancelQuestionnaire('smoke test');
  await Promise.resolve();

  planApp.s.clear(T.bg, T.fg);
  drawPlanPanel(planApp.s, planApp.st, 1, 1, 82, 0, 20);
  let fromHit = planApp.st.plan.hits.find((hit) => hit.id === 'visible-9');
  planApp.onKey({ name: 'mousedown', mouse: true, x: fromHit.x1 + 2, y: fromHit.y });
  ok('Plan Todo mousedown selects without completing', planApp.st.plan.drag?.id === 'visible-9'
    && planApp.st.plan.todos.find((todo) => todo.id === 'visible-9')?.status === 'pending');
  planApp.onKey({ name: 'mouseup', mouse: true, x: fromHit.x1 + 2, y: fromHit.y });
  ok('Plan Todo click toggles completion on mouseup', !planApp.st.plan.drag
    && planApp.st.plan.todos.find((todo) => todo.id === 'visible-9')?.status === 'completed');

  planApp.s.clear(T.bg, T.fg);
  drawPlanPanel(planApp.s, planApp.st, 1, 1, 82, 0, 20);
  fromHit = planApp.st.plan.hits.find((hit) => hit.id === 'visible-9');
  const toHit = planApp.st.plan.hits.find((hit) => hit.id === 'visible-6');
  planApp.onKey({ name: 'mousedown', mouse: true, x: fromHit.x1 + 2, y: fromHit.y });
  planApp.onKey({ name: 'mousedrag', mouse: true, dragging: true, x: toHit.x1 + 2, y: toHit.y });
  planApp.onKey({ name: 'mouseup', mouse: true, x: toHit.x1 + 2, y: toHit.y });
  ok('Plan Todo drag reorders without toggling completion', planApp.st.plan.todos[5]?.id === 'visible-9'
    && planApp.st.plan.todos[5]?.status === 'completed' && !planApp.st.plan.drag);

  const revisions = [];
  planApp.backend = {
    rejectPlan(snapshot, feedback) {
      revisions.push({ snapshot, feedback });
      return Promise.resolve(snapshot);
    },
  };
  planApp.st.plan.approval = 'pending';
  const revisionRequest = planApp.rejectPlan();
  ok('Plan N opens a required revision-feedback editor', planApp.st.questionnaire.open
    && planApp.st.questionnaire.title === 'REVISE PLAN');
  planApp.setQuestionnaireAnswer('feedback', 'Keep the renderer API unchanged.');
  planApp.finishQuestionnaire();
  await revisionRequest;
  ok('Plan revision feedback reaches the backend and leaves Plan active', revisions.length === 1
    && revisions[0].feedback === 'Keep the renderer API unchanged.'
    && revisions[0].snapshot.approval === 'rejected'
    && revisions[0].snapshot.mode === 'plan');

  planApp.st.plan.approval = 'pending';
  const cancelledRevision = planApp.rejectPlan();
  planApp.cancelQuestionnaire('keep current proposal');
  await cancelledRevision;
  ok('cancelling Plan revision feedback keeps the proposal pending', planApp.st.plan.approval === 'pending'
    && revisions.length === 1);

  planApp.backend.rejectPlan = async () => { throw new Error('revision backend offline'); };
  const failedRevision = planApp.rejectPlan();
  planApp.setQuestionnaireAnswer('feedback', 'Retry this feedback later.');
  planApp.finishQuestionnaire();
  await failedRevision;
  ok('failed Plan revision delivery rolls back to a retryable approval', planApp.st.plan.approval === 'pending');

  planApp.clock.stop();
  for (const id of planApp.timers) clearTimeout(id);
}

{
  const snapshots = [];
  const backend = new PiBackend();
  backend.session = {
    sessionManager: {
      appendCustomEntry(type, data) { snapshots.push({ type, data }); },
    },
  };
  backend.updatePlan({
    action: 'replace',
    mode: 'plan',
    intent: 'Keep manual edits after restart',
    todos: [{ id: 'persisted', text: 'Persist this Todo', status: 'pending' }],
    source: 'user',
  });
  ok('manual Plan edits append a restorable Pi session snapshot', snapshots.length === 1
    && snapshots[0].type === 'approx-plan-state'
    && snapshots[0].data.plan.todos[0]?.id === 'persisted');
}

// ---- questionnaire keyboard return path + permanent free-form choice ----
{
  const questionsApp = new App({ noSplash: true });
  questionsApp.s = new Screen(new FakeOut(90, 30));
  const resultPromise = questionsApp.openQuestionnaire({
    id: 'keyboard-questions',
    questions: [
      {
        id: 'channel', type: 'single', prompt: 'Choose a channel',
        options: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }],
      },
      {
        id: 'confirm', type: 'single', prompt: 'Confirm',
        options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
      },
    ],
  });
  const first = questionsApp.st.questionnaire.questions[0];
  ok('choice questions always append Something else', first.options.at(-1)?.label === 'Something else');

  questionsApp.questionnaireKey({ name: 'enter' });
  questionsApp.questionnaireBack();
  questionsApp.questionnaireKey({ name: 'down' });
  ok('keyboard arrows immediately select the focused radio choice', questionsApp.st.questionnaire.answers.channel === 'beta');
  questionsApp.questionnaireKey({ name: 'enter' });
  ok('keyboard Enter replaces an earlier choice after Back', questionsApp.st.questionnaire.index === 1
    && questionsApp.st.questionnaire.answers.channel === 'beta');

  questionsApp.questionnaireBack();
  questionsApp.questionnaireKey({ name: 'down' });
  questionsApp.st.questionnaire.anim.set(1, true);
  questionsApp.render(0.25);
  ok('Something else opens a visible inline text field', questionsApp.st.questionnaire.otherEditing
    && questionsApp.s.ch.join('').includes('Type your own answer'));
  ok('questionnaire veil fully hides transcript outside the panel', questionsApp.s.fg[0] === questionsApp.s.bg[0]);
  for (const ch of 'Custom channel') questionsApp.questionnaireKey({ name: ch, printable: true });
  questionsApp.questionnaireKey({ name: 'enter' });
  questionsApp.questionnaireKey({ name: 'enter' });
  const questionsResult = await resultPromise;
  ok('Something else returns the typed value to the tool', questionsResult.values.channel === 'Custom channel');

  const multiResultPromise = questionsApp.openQuestionnaire({
    questions: [{
      id: 'features', type: 'multi', prompt: 'Select features',
      options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }],
    }],
  });
  questionsApp.questionnaireKey({ name: 'space' });
  questionsApp.questionnaireKey({ name: 'enter' });
  const multiResult = await multiResultPromise;
  ok('multi-choice Enter continues without toggling the cursor twice', multiResult.values.features.join(',') === 'one');
  questionsApp.clock.stop();
  for (const id of questionsApp.timers) clearTimeout(id);
}

// Slash commands are the top prompt layer even while the Plan panel is focused.
{
  const layerApp = new App({ noSplash: true });
  layerApp.s = new Screen(new FakeOut(86, 24));
  layerApp.st.plan = createPlanState({
    mode: 'plan', proposal: 'Layer priority', approval: 'approved',
    todos: [
      { id: 'layer-1', text: 'First' },
      { id: 'layer-2', text: 'Second' },
      { id: 'layer-3', text: 'Third' },
    ],
  });
  layerApp.st.plan.focused = true;
  layerApp.st.plan.anim.set(1, true);
  setComposerInput(layerApp.st, '/');
  layerApp.refreshSlash();
  layerApp.st.slashAnim.set(1, true);
  const oldPlanCursor = layerApp.st.plan.cursor;
  layerApp.onKey({ name: 'down' });
  ok('slash menu owns keyboard focus above Plan', layerApp.st.slashIndex === 1
    && layerApp.st.plan.cursor === oldPlanCursor);
  layerApp.render(0.25);
  ok('slash menu paints above the Plan panel', layerApp.s.ch.join('').includes('COMMANDS'));
  layerApp.clock.stop();
  for (const id of layerApp.timers) clearTimeout(id);
}

// Preference serialization is UTF-8 JSON and survives a fresh read.
{
  const dir = mkdtempSync(join(tmpdir(), 'approx-settings-'));
  const file = join(dir, 'settings.json');
  savePreferences({ markdown: false, effort: 'high', label: '中文' }, file);
  const restored = loadPreferences(file);
  ok('settings persist as utf8 json', restored.markdown === false && restored.effort === 'high' && restored.label === '中文');
  rmSync(dir, { recursive: true, force: true });
}

// ---- splash renders across its whole timeline ----
let splashThrew = null;
try {
  for (let ms = 0; ms <= SPLASH_MS + 60; ms += 17) drawSplash(s, ms);
} catch (e) {
  splashThrew = e;
}
ok('splash renders', !splashThrew);
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
  ok('palette keeps ten curated controls plus Git and conversation history', app.st.paletteResults.length === 10
    && app.st.paletteResults.some((item) => item.name === 'history')
    && app.st.paletteResults.some((item) => item.name === 'git')
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

// ---- prompt queue: structured final delivery, deletion, and deferred runtime ----
{
  class QueueBackend {
    constructor() { this.listeners = new Set(); this.prompts = []; this.aborts = 0; this.models = []; this.efforts = []; }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(event) { for (const fn of this.listeners) fn(event); }
    prompt(text) { this.prompts.push(text); return Promise.resolve(); }
    abort() { this.aborts++; return Promise.resolve(); }
    setModel(model) { this.models.push(model); this.emit({ type: 'model', model }); return Promise.resolve(); }
    setEffort(effort) { this.efforts.push(effort); this.emit({ type: 'effort', effort }); return effort; }
    dispose() {}
  }
  const backend = new QueueBackend();
  const c = new App({ noSplash: true, backend });
  c.s = new Screen(new FakeOut(88, 28));
  c.st.modelOptions = [{ provider: 'test', id: 'a', label: 'a' }, { provider: 'test', id: 'b', label: 'b' }];
  c.st.model = 'a';
  c.st.effortOptions = ['low', 'high'];
  c.st.effort = 'low';

  c.submitText('first request');
  c.submitText('second request');
  c.submitText('third request');
  ok('busy submits stay out of transcript and context in FIFO queue', backend.prompts.join('|') === 'first request'
    && c.st.messageQueue.map((item) => item.text).join('|') === 'second request|third request'
    && c.st.msgs.filter((msg) => msg.role === 'user').length === 1);

  // Hidden continuations (such as approved Plan execution) have no App turn
  // envelope. Pi remains authoritative during the brief gap around a WORK note.
  const runtimeBackend = new QueueBackend();
  runtimeBackend.runtimeBusy = true;
  runtimeBackend.isBusy = () => runtimeBackend.runtimeBusy;
  const runtimeQueued = new App({ noSplash: true, backend: runtimeBackend });
  runtimeQueued.submitText('queued during work note');
  ok('runtime-active WORK note always accepts a queued prompt', runtimeBackend.prompts.length === 0
    && runtimeQueued.st.messageQueue[0]?.text === 'queued during work note');
  runtimeQueued.drainMessageQueue();
  ok('runtime-active WORK note cannot drain its queue early', runtimeBackend.prompts.length === 0
    && runtimeQueued.st.messageQueue.length === 1);
  runtimeBackend.runtimeBusy = false;
  runtimeQueued.drainMessageQueue();
  ok('runtime-idle boundary dispatches the queued WORK-note prompt', runtimeBackend.prompts[0] === 'queued during work note'
    && runtimeQueued.st.messageQueue.length === 0);

  c.setModel(c.st.modelOptions[1]);
  c.setEffort('high');
  ok('runtime switch records pending values without touching active task', c.st.model === 'a' && c.st.effort === 'low'
    && c.st.pendingModel?.id === 'b' && c.st.pendingEffort === 'high');

  backend.emit({ type: 'assistant_start' });
  backend.emit({ type: 'assistant_delta', delta: 'progress note' });
  backend.emit({ type: 'assistant_end', text: 'progress note', stopReason: 'toolUse' });
  await new Promise((resolve) => setImmediate(resolve));
  ok('toolUse assistant text never releases the next queued prompt', backend.prompts.length === 1 && c.st.messageQueue.length === 2);

  backend.emit({ type: 'assistant_start' });
  backend.emit({ type: 'assistant_delta', delta: 'final answer' });
  backend.emit({ type: 'assistant_end', text: 'final answer', stopReason: 'stop' });
  ok('final assistant waits for runtime settled before dequeue', backend.prompts.length === 1);
  backend.emit({ type: 'settled' });
  await new Promise((resolve) => setImmediate(resolve));
  ok('settled final applies runtime switches before dispatching FIFO head', backend.models.at(-1)?.id === 'b'
    && backend.efforts.at(-1) === 'high' && backend.prompts.join('|') === 'first request|second request'
    && c.st.messageQueue[0]?.text === 'third request');

  c.submitText('fourth request');
  c.submitText('fifth request');
  c.submitText('sixth request');
  setComposerInput(c.st, 'seventh request');
  c.submit();
  ok('queue accepts at most four and keeps an overflow draft', c.st.messageQueue.length === 4
    && c.st.input === 'seventh request');
  c.onKey({ name: 'backspace', alt: true });
  ok('alt-backspace removes the queue tail without editing composer', c.st.messageQueue.length === 3
    && !c.st.messageQueue.some((item) => item.text === 'sixth request') && c.st.input === 'seventh request');

  c.update(1 / 30, 0.3);
  c.render(0.3);
  ok('queue renders a distinct animated card with clickable deletes', c.s.ch.join('').includes('QUEUE')
    && c.st.queueHits.length === c.st.messageQueue.length);
  const click = c.st.queueHits[1];
  c.onKey({ name: 'mousedown', mouse: true, x: click.x1, y: click.y });
  ok('queue row delete target removes exactly the clicked prompt', c.st.messageQueue.length === 2
    && !c.st.messageQueue.some((item) => item.text === 'fourth request'));

  // ESC is a terminal turn outcome of its own and advances the queue after abort.
  c.interrupt();
  await new Promise((resolve) => setImmediate(resolve));
  ok('escape abort advances to the next queued prompt', backend.aborts === 1
    && backend.prompts.at(-1) === 'third request');

  c.backendUnsubscribe?.();
  c.clock.stop();
  runtimeQueued.backendUnsubscribe?.();
  runtimeQueued.clock.stop();
}

// ---- live backend bridge: normalized agent events ----
{
  class FakeBackend {
    constructor() {
      this.listeners = new Set(); this.prompts = []; this.aborts = 0; this.models = [];
      this.efforts = []; this.resets = 0; this.switched = [];
      this.news = 0;
    }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(event) { for (const fn of this.listeners) fn(event); }
    prompt(text) { this.prompts.push(text); return Promise.resolve(); }
    abort() { this.aborts++; return Promise.resolve(); }
    setModel(model) { this.models.push(model); return Promise.resolve(); }
    cycleModel() { this.emit({ type: 'model', model: { provider: 'test', id: 'model-b', label: 'model-b' } }); return Promise.resolve(); }
    setEffort(effort) { this.efforts.push(effort); this.emit({ type: 'effort', effort }); return effort; }
    cycleEffort() { this.emit({ type: 'effort', effort: 'high' }); return 'high'; }
    resetContext() { this.resets++; this.emit({ type: 'context_reset', sessionId: 'session-2' }); return Promise.resolve(); }
    newConversation() { this.news++; this.emit({ type: 'conversation_new', sessionId: 'session-new', sessionFile: 'NEW_SESSION' }); return Promise.resolve(); }
    listSessions() {
      return Promise.resolve([{ path: 'OLD_SESSION', title: 'Earlier conversation', modifiedLabel: '2h', messageCount: 4, current: false }]);
    }
    switchSession(path) {
      this.switched.push(path);
      this.emit({ type: 'ready', sessionId: 'old-session', sessionFile: path, model: { provider: 'test', id: 'model-a', label: 'model-a' } });
      this.emit({ type: 'history', messages: [{ role: 'user', text: 'old question' }, { role: 'approx', text: 'old answer' }] });
      return Promise.resolve();
    }
    dispose() {}
  }

  const backend = new FakeBackend();
  const c = new App({ noSplash: true, backend });
  c.s = new Screen(new FakeOut(80, 24));
  backend.emit({
    type: 'ready', runtime: 'Approx test', sessionId: 'session-1', effort: 'medium',
    effortOptions: ['low', 'medium', 'high'],
    model: { provider: 'test', id: 'model-a', label: 'model-a' },
    models: [
      { provider: 'test', id: 'model-a', label: 'model-a' },
      { provider: 'test', id: 'model-b', label: 'model-b' },
    ],
  });
  c.seed();

  ok('backend ready lands runtime state', c.st.runtime === 'Approx test' && c.st.model === 'model-a');
  c.st.input = '/model ';
  c.refreshSlash();
  ok('model slash opens model choices', c.st.slashMatches.length === 2 && c.st.slashMatches.every((it) => it.terminal));
  c.st.input = '/effort h';
  c.refreshSlash();
  ok('effort slash filters choices', c.st.slashMatches.length === 1 && c.st.slashMatches[0].name === '/effort high');
  c.st.input = '/markdown ';
  c.refreshSlash();
  ok('markdown slash offers on and off', c.st.slashMatches.map((it) => it.name).join('|') === '/markdown on|/markdown off');
  c.st.input = '';
  c.refreshSlash();
  c.submitText('hello Approx');
  ok('backend receives user prompt', backend.prompts[0] === 'hello Approx' && c.st.busy);

  backend.emit({ type: 'assistant_start' });
  for (const chunk of ['r', 'e', 'a', 'l', ' ', 's', 't', 'r', 'e', 'a', 'm']) {
    backend.emit({ type: 'assistant_delta', delta: chunk });
  }
  ok('fast deltas are coalesced until one frame', c.liveAssistant.text === '' && c._pendingLiveDelta === 'real stream');
  backend.emit({ type: 'assistant_end', text: 'real stream' });
  ok('backend deltas build one assistant message', c.st.msgs.filter((m) => m.role === 'approx').at(-1)?.text === 'real stream');

  backend.emit({ type: 'tool_start', id: 'call-1', name: 'read', title: 'Read renderer', meta: 'file.js' });
  backend.emit({ type: 'tool_update', id: 'call-1', text: 'partial' });
  backend.emit({ type: 'tool_end', id: 'call-1', text: 'done', isError: false });
  const tool = c.st.msgs.find((m) => m.callId === 'call-1');
  ok('backend tool lifecycle updates in place', tool?.text === 'done' && tool.running === false);
  ok('tool starts folded with title', tool?.expanded === false && tool?.title === 'Read renderer');
  const foldedHeight = totalHeight([tool], 60);
  c.toggleTool(tool);
  for (let i = 0; i < 40; i++) c.update(1 / 30, i / 30);
  ok('tool expands through animated height', tool.expanded && totalHeight([tool], 60) > foldedHeight);
  c.toggleFocusedTool();
  ok('ctrl-u target folds focused tool', tool.expanded === false);
  const heldMessages = c.st.msgs;
  c.st.msgs = [tool];
  c.st.scroll = 0;
  c.st.scrollTarget = 0;
  const toolVp = c.viewport();
  c.onKey({ name: 'mousedown', mouse: true, x: toolVp.x + 4, y: toolVp.y + 1 });
  ok('click expands folded tool', tool.expanded === true);
  c.st.msgs = heldMessages;

  backend.emit({ type: 'context', percent: 42 });
  ok('backend context drives meter target', Math.abs(c.st.ctxUse.target - 0.42) < 0.001);
  backend.emit({ type: 'settled' });
  await new Promise((resolve) => setImmediate(resolve));
  c.submitText('/skill:fixture test');
  ok('unknown slash command forwards to backend', backend.prompts.at(-1) === '/skill:fixture test');

  applySetting(c, 'model', 'model-b');
  applySetting(c, 'effort', 'high');
  ok('busy model and effort changes are visibly deferred', backend.models.length === 0 && backend.efforts.length === 0
    && c.st.pendingModel?.id === 'model-b' && c.st.pendingEffort === 'high');
  backend.emit({ type: 'assistant_end', text: 'extension complete', stopReason: 'stop' });
  backend.emit({ type: 'settled' });
  await new Promise((resolve) => setImmediate(resolve));
  ok('deferred model and effort apply after final delivery', backend.models.at(-1)?.id === 'model-b'
    && backend.efforts.at(-1) === 'high' && c.st.effort === 'high');
  c.commandMarkdown('off');
  ok('markdown command toggles renderer', c.st.markdown === false && c.st.msgs.every((msg) => msg.markdown === false));
  c.showHelp();
  ok('help is a guest-only message', c.st.msgs.at(-1)?.role === 'guest');

  ok('palette includes saved conversations', c.cmds.some((cmd) => cmd.name === 'history' && cmd.key === '^s'));
  c.openSessions();
  await Promise.resolve();
  ok('conversation picker loads auto-saved sessions', c.st.sessionPicker.open
    && c.st.sessionPicker.items[0]?.title === 'Earlier conversation');
  let sessionsThrew = false;
  try { c.update(1 / 30, 0.2); c.render(0.2); } catch { sessionsThrew = true; }
  ok('conversation picker renders', !sessionsThrew);
  c.onKey({ name: 'enter' });
  ok('returning to a conversation rehydrates transcript', backend.switched[0] === 'OLD_SESSION'
    && c.st.msgs.map((msg) => msg.text).join('|') === 'old question|old answer');

  backend.emit({ type: 'assistant_start' });
  backend.emit({ type: 'assistant_delta', delta: '真实流式 token 计数' });
  c.update(1 / 30, 0.25);
  ok('tps is driven by output deltas', c.st.tpsNow > 0);

  c.clearTranscript();
  ok('clear resets backend context', backend.resets === 1 && c.st.msgs.length === 0);

  c.push({ role: 'user', text: 'old branch', enter: 1 });
  c.newConversation();
  ok('new starts a separate conversation without reusing clear', backend.news === 1 && c.st.msgs.length === 0
    && c.st.sessionId === 'session-new');

  c.st.busy = true;
  c.interrupt();
  ok('interrupt reaches backend', backend.aborts === 1);

  c.backendUnsubscribe?.();
  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}

// ---- edit/retry rewind, one-step redo, and terminal-style selection ----
{
  const out = new FakeOut(88, 28);
  const c = new App({ noSplash: true });
  c.s = new Screen(out);
  c.push({ role: 'system', text: 'session ready', enter: 1 });
  const user = c.push({ role: 'user', text: 'original request', enter: 1 });
  c.push({ role: 'approx', text: 'old answer', enter: 1 });
  c.push({
    role: 'tool', name: 'edit', title: 'Edit fixture', text: 'done', enter: 1,
    mutation: { kind: 'edit', path: 'FIXTURE', before: { exists: true, data: 'YQ==' }, after: { exists: true, data: 'Yg==' } },
  });
  c.push({ role: 'approx', text: 'old follow-up', enter: 1 });
  c.update(1 / 30, 0);
  c.render(0);

  c.onKey({ name: 'e', ctrl: true });
  ok('ctrl-e selects latest user turn first', c.st.messageEdit.mode === 'selected' && c.st.messageEdit.target === user);
  c.onKey({ name: 'e', ctrl: true });
  ok('second ctrl-e loads message into editor', c.st.messageEdit.mode === 'editing' && c.st.input === user.text);
  c.onKey({ name: 'enter' });
  ok('unchanged edit opens retry confirmation', c.st.messageEdit.mode === 'confirm'
    && c.st.messageEdit.messageCount === 4 && c.st.messageEdit.mutationCount === 1);
  for (let i = 0; i < 20; i++) c.update(1 / 60, i / 60);
  c.render(0.35);
  ok('rewind confirmation renders its animated label', c.s.ch.join('').includes('REWIND?'));
  c.onKey({ name: 'n', printable: true });
  ok('rewind no keeps editable draft', c.st.messageEdit.mode === 'editing' && c.st.input === user.text);
  c.onKey({ name: 'enter' });
  c.onKey({ name: 'y', printable: true });
  const retry = c.st.msgs.at(-1);
  ok('rewind replaces suffix with retry turn', c.st.msgs.length === 2 && retry.role === 'user'
    && retry.text === user.text && retry.redoAvailable === true);
  c.update(1 / 30, 0.1);
  c.render(0.1);
  ok('retry turn exposes a rendered redo hit target', retry._redoHit?.x2 >= retry._redoHit?.x1);
  c.onKey({ name: 'r', alt: true });
  ok('alt-r restores abandoned branch once', c.st.msgs.length === 5 && c.st.msgs[1] === user && c.st.redo === null);

  // Double click selects on the first press and enters edit on the second.
  c.st.wipe = 0;
  c.scrollTo(0);
  c.st.scrollSpring.set(0, true);
  c.render(0.2);
  const vp = c.viewport();
  const uy = vp.y + 4; // system occupies three rows; next header is the user turn
  c.onKey({ name: 'mousedown', mouse: true, x: vp.x + 5, y: uy });
  ok('first user click shows selection state', c.st.messageEdit.mode === 'selected');
  c.onKey({ name: 'mousedown', mouse: true, x: vp.x + 5, y: uy });
  ok('double click enters user edit', c.st.messageEdit.mode === 'editing');
  c.cancelMessageEdit();

  // Dragging across a rendered transcript row highlights and copies with OSC 52.
  c.render(0.3);
  const bodyY = uy;
  c.onKey({ name: 'mousedown', mouse: true, x: vp.x + 3, y: bodyY });
  c.onKey({ name: 'mousedrag', mouse: true, dragging: true, x: vp.x + 11, y: bodyY });
  c.onKey({ name: 'mouseup', mouse: true, x: vp.x + 11, y: bodyY });
  ok('mouse drag retains a visible selection', c.st.textSelection && c.st.textSelection.active === false);
  ok('mouse release copies selection with osc52', out.buf.includes('\x1b]52;c;'));

  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}

// ---- history replacement clears state owned by the previous conversation ----
{
  const c = new App({ noSplash: true });
  c.s = new Screen(new FakeOut(88, 28));
  c.st.redo = { used: false };
  c.st.textSelection = { active: true };
  c.st.jump = true;
  c.st.railTicks = [{ index: 99 }];
  c.st.railHover = 3;
  c._tokenEvents = [{ at: 1, tokens: 2 }];
  c.loadHistory([{ role: 'user', text: 'replacement history' }]);
  ok('history replacement clears stale redo and transcript interaction state',
    c.st.redo === null && c.st.textSelection === null && !c.st.jump
    && c.st.railTicks.length === 0 && c.st.railHover === -1 && c._tokenEvents.length === 0);
  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}

// ---- three adjacent tools become one named, two-level group ----
{
  const c = new App({ noSplash: true });
  c.s = new Screen(new FakeOut(90, 28));
  const starts = [
    { id: 'g-1', name: 'read', title: 'Read package.json', groupTitle: 'Inspect project structure', modelGroupTitle: true },
    { id: 'g-2', name: 'read', title: 'Read app.js' },
    { id: 'g-3', name: 'grep', title: 'Search tool routing' },
  ];
  const nestedTools = [...toolMessages({
    role: 'workgroup', tools: [{
      role: 'toolgroup', tools: [{ role: 'tool', callId: 'a' }, { role: 'tool', callId: 'b' }],
    }],
  })];
  ok('shared tool-tree walk returns nested leaf tools in display order',
    nestedTools.map((tool) => tool.callId).join('|') === 'a|b');
  c.onBackendEvent({ type: 'tool_start', ...starts[0] });
  c.onBackendEvent({ type: 'tool_start', ...starts[1] });
  ok('two adjacent tools stay independent', c.st.msgs.length === 2 && c.st.msgs.every((msg) => msg.role === 'tool'));
  c.onBackendEvent({ type: 'tool_start', ...starts[2] });
  const group = c.st.msgs[0];
  ok('third adjacent tool creates one group', c.st.msgs.length === 1 && group.role === 'toolgroup' && group.tools.length === 3);
  ok('tool group keeps model batch title', group.title === 'Inspect project structure' && group.modelTitle === true);
  ok('tool group starts folded', !group.expanded && visibleLines(group, 70).length === 1);

  c.onBackendEvent({ type: 'tool_update', id: 'g-2', text: 'app body' });
  c.onBackendEvent({ type: 'tool_end', id: 'g-1', text: 'package body', isError: false });
  c.onBackendEvent({ type: 'tool_end', id: 'g-2', text: 'app body', isError: false });
  c.onBackendEvent({ type: 'tool_end', id: 'g-3', text: 'grep failed', isError: true });
  ok('grouped live tools still update in place', group.tools[1].text === 'app body' && group.tools[2].isError === true);

  const folded = totalHeight([group], 70);
  c.toggleToolGroup(group);
  for (let i = 0; i < 40; i++) c.update(1 / 30, i / 30);
  ok('first level reveals child summaries', visibleLines(group, 70).filter((line) => line.kind === 'toolchildhead').length === 3
    && totalHeight([group], 70) > folded);
  c.toggleTool(group.tools[1]);
  for (let i = 0; i < 40; i++) c.update(1 / 30, i / 30);
  ok('second level reveals one child output', visibleLines(group, 70).some((line) => line.kind === 'toolchildbody' && line.tool === group.tools[1]));

  const snap = c.snapshot()[0];
  ok('snapshot preserves grouped tool structure', snap.role === 'toolgroup' && snap.tools.length === 3 && snap.title === group.title);

  // Keyboard expansion walks from the outer group to its latest child.
  group.tools.forEach((tool) => { tool.expanded = false; tool.expandAnim.set(0, true); });
  group.expanded = false;
  group.expandAnim.set(0, true);
  c.st.toolFocus = group.callId;
  c.toggleFocusedTool();
  ok('ctrl-u opens group level first', group.expanded && c.st.toolFocus === group.tools.at(-1).callId);
  c.toggleFocusedTool();
  ok('ctrl-u then opens focused child level', group.tools.at(-1).expanded === true);

  // Pointer hit-testing resolves the nested row, not just the outer message.
  group.expanded = true;
  group.expandAnim.set(1, true);
  group.tools[0].expanded = false;
  group.tools[0].expandAnim.set(0, true);
  c.st.scroll = 0;
  c.st.scrollTarget = 0;
  const vp = c.viewport();
  c.onKey({ name: 'mousedown', mouse: true, x: vp.x + 8, y: vp.y + 2 });
  ok('click opens a nested tool row', group.tools[0].expanded === true && group.expanded === true);
  c.onKey({ name: 'mousedown', mouse: true, x: vp.x + 8, y: vp.y + 1 });
  ok('click on group bar folds outer level', group.expanded === false);

  const promotedApp = new App({ noSplash: true });
  promotedApp.onBackendEvent({
    type: 'tool_start', id: 'p-1', name: 'bash', title: 'Measure repository scale',
    fallbackTitle: 'Run project metrics', modelTitle: true,
  });
  promotedApp.onBackendEvent({ type: 'tool_start', id: 'p-2', name: 'bash', title: 'Run line count', fallbackTitle: 'Run line count' });
  promotedApp.onBackendEvent({ type: 'tool_start', id: 'p-3', name: 'bash', title: 'Run file count', fallbackTitle: 'Run file count' });
  const promoted = promotedApp.st.msgs[0];
  ok('first model heading is promoted when a 3-call batch omitted its prefix', promoted.role === 'toolgroup'
    && promoted.title === 'Measure repository scale' && promoted.modelTitle === true);
  ok('promoted batch title no longer duplicates first child', promoted.tools[0].title === 'Run project metrics');

  // Final delivery archives an interleaved work phase into a three-level tree.
  const archived = new App({ noSplash: true });
  archived.s = new Screen(new FakeOut(90, 28));
  archived.push({ role: 'user', text: 'archive this turn' });
  archived.push({ role: 'approx', text: 'I am checking the files', stopReason: 'toolUse' });
  archived.push({ role: 'tool', name: 'read', title: 'Read app.js', text: 'source' });
  archived.push({ role: 'approx', text: 'One more pass', stopReason: 'toolUse' });
  archived.push({ role: 'tool', name: 'grep', title: 'Search routes', text: 'matches' });
  archived.push({ role: 'approx', text: 'Final answer', stopReason: 'stop' });
  ok('final delivery creates one WORK archive', archived.archiveCompletedWork()
    && archived.st.msgs.map((msg) => msg.role).join('|') === 'user|workgroup|approx');
  const work = archived.st.msgs[1];
  ok('WORK archive keeps notes and one Tool Calls parent', work.notes.length === 2
    && work.tools.length === 1 && work.tools[0].role === 'toolgroup');
  ok('Tool Calls parent keeps every child call', work.tools[0].tools.length === 2);
  work.expanded = true;
  work.expandAnim.set(1, true);
  work.tools[0].expanded = true;
  work.tools[0].expandAnim.set(1, true);
  ok('three-level archive renders note, parent, and child rows', visibleLines(work, 70).some((line) => line.kind === 'worknote')
    && visibleLines(work, 70).some((line) => line.kind === 'worktoolhead')
    && visibleLines(work, 70).filter((line) => line.kind === 'toolchildhead').length === 2);
  const archivedSnap = archived.snapshot()[1];
  ok('snapshot preserves archived work hierarchy', archivedSnap.role === 'workgroup'
    && archivedSnap.notes.length === 2 && archivedSnap.tools[0].tools.length === 2);

  const silent = new App({ noSplash: true });
  silent.push({ role: 'user', text: 'tool-only turn' });
  silent.push({ role: 'tool', name: 'read', title: 'Read file' });
  silent.push({ role: 'approx', text: 'done', stopReason: 'stop' });
  silent.archiveCompletedWork();
  ok('tool-only archive gets a deterministic fallback Note', silent.st.msgs[1]?.notes?.[0]?.synthetic === true);
  silent.clock.stop();
  for (const id of silent.timers) clearTimeout(id);

  const staged = new App({ noSplash: true });
  staged.push({ role: 'user', text: 'multi-stage turn' });
  staged.onBackendEvent({ type: 'assistant_start' });
  staged.onBackendEvent({ type: 'assistant_delta', delta: 'stage one' });
  staged.onBackendEvent({ type: 'assistant_end', text: 'stage one', stopReason: 'stop' });
  staged.onBackendEvent({ type: 'tool_start', id: 'stage-read', name: 'read', title: 'Read file' });
  staged.onBackendEvent({ type: 'tool_end', id: 'stage-read', text: 'ok' });
  staged.onBackendEvent({ type: 'assistant_start' });
  staged.onBackendEvent({ type: 'assistant_delta', delta: 'final' });
  staged.onBackendEvent({ type: 'assistant_end', text: 'final', stopReason: 'stop' });
  ok('assistant progress is not archived before backend settlement', staged.st.msgs.some((msg) => msg.role === 'tool'));
  staged.onBackendEvent({ type: 'settled' });
  ok('settlement folds every stage into one WORK', staged.st.msgs.map((msg) => msg.role).join('|') === 'user|workgroup|approx'
    && staged.st.msgs[1].notes[0].text === 'stage one');
  staged.clock.stop();
  for (const id of staged.timers) clearTimeout(id);

  // A phase-level settlement may arrive before the request promise resolves.
  // Keep every later note/tool flat until the actual turn boundary is complete.
  class DeferredArchiveBackend {
    constructor() { this.listeners = new Set(); this.resolvePrompt = null; }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(event) { for (const fn of this.listeners) fn(event); }
    prompt() { return new Promise((resolve) => { this.resolvePrompt = resolve; }); }
    dispose() {}
  }
  const deferredBackend = new DeferredArchiveBackend();
  const deferred = new App({ noSplash: true, backend: deferredBackend });
  deferred.s = new Screen(new FakeOut(90, 28));
  deferred.submitText('keep every work phase together');
  deferredBackend.emit({ type: 'assistant_start' });
  deferredBackend.emit({ type: 'assistant_delta', delta: 'first progress note' });
  deferredBackend.emit({ type: 'assistant_end', text: 'first progress note', stopReason: 'toolUse' });
  deferredBackend.emit({ type: 'tool_start', id: 'deferred-read', name: 'read', title: 'Read file' });
  deferredBackend.emit({ type: 'tool_end', id: 'deferred-read', text: 'ok' });
  deferredBackend.emit({ type: 'assistant_start' });
  deferredBackend.emit({ type: 'assistant_delta', delta: 'middle progress note' });
  deferredBackend.emit({ type: 'assistant_end', text: 'middle progress note', stopReason: 'stop' });
  deferredBackend.emit({ type: 'tool_start', id: 'deferred-grep', name: 'grep', title: 'Search project' });
  deferredBackend.emit({ type: 'tool_end', id: 'deferred-grep', text: 'ok' });
  deferredBackend.emit({ type: 'settled' });
  ok('phase-level settlement leaves WORK open for later tool activity', !deferred.st.msgs.some((msg) => msg.role === 'workgroup'));
  deferredBackend.emit({ type: 'assistant_start' });
  deferredBackend.emit({ type: 'assistant_delta', delta: 'final result' });
  deferredBackend.emit({ type: 'assistant_end', text: 'final result', stopReason: 'stop' });
  deferredBackend.resolvePrompt();
  await new Promise((resolve) => setImmediate(resolve));
  ok('completed turn archives every earlier phase under one WORK', deferred.st.msgs.map((msg) => msg.role).join('|') === 'user|workgroup|approx'
    && deferred.st.msgs[1].notes.length === 2 && deferred.st.msgs[1].tools[0].tools.length === 2);
  deferred.backendUnsubscribe?.();
  deferred.clock.stop();
  for (const id of deferred.timers) clearTimeout(id);

  const repaired = new App({ noSplash: true });
  repaired.push({ role: 'user', text: 'repair a partially archived turn' });
  repaired.push({ role: 'workgroup', title: 'Work', notes: [{ role: 'approx', text: 'old stage' }], tools: [
    { role: 'toolgroup', title: 'Tool Calls', tools: [{ role: 'tool', name: 'read', title: 'Old call' }] },
  ] });
  repaired.push({ role: 'approx', text: 'later stage', stopReason: 'stop' });
  repaired.push({ role: 'tool', name: 'grep', title: 'Later call' });
  repaired.push({ role: 'approx', text: 'final', stopReason: 'stop' });
  repaired.archiveCompletedWork();
  ok('partial archive self-repairs into one WORK', repaired.st.msgs.map((msg) => msg.role).join('|') === 'user|workgroup|approx'
    && repaired.st.msgs[1].notes.length === 2 && repaired.st.msgs[1].tools[0].tools.length === 2);
  repaired.clock.stop();
  for (const id of repaired.timers) clearTimeout(id);

  archived.clock.stop();
  for (const id of archived.timers) clearTimeout(id);

  promotedApp.clock.stop();

  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}

// ---- backend tool titles: model heading is consumed into the folded card ----
{
  const backend = new PiBackend();
  const events = [];
  backend.subscribe((event) => events.push(event));
  backend.onPiEvent({ type: 'agent_start' });
  backend.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } });
  backend.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '### Inspect renderer' } });
  backend.onPiEvent({
    type: 'message_end',
    message: {
      role: 'assistant', content: [{ type: 'text', text: '### Inspect renderer' }],
      stopReason: 'toolUse', usage: { output: 4 },
    },
  });
  backend.onPiEvent({ type: 'tool_execution_start', toolCallId: 'named-1', toolName: 'read', args: { path: 'src/screen.js' } });
  const end = events.find((event) => event.type === 'assistant_end');
  const start = events.find((event) => event.type === 'tool_start');
  ok('model tool heading is hidden from answer', end?.text === '');
  ok('model tool heading names card', start?.title === 'Inspect renderer' && start.modelTitle === true);

  const integrated = new App({ noSplash: true, backend });
  backend.onPiEvent({ type: 'agent_start' });
  backend.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } });
  backend.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '### Inspect input routing' } });
  backend.onPiEvent({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: '### Inspect input routing' }], stopReason: 'toolUse' },
  });
  backend.onPiEvent({ type: 'tool_execution_start', toolCallId: 'named-2', toolName: 'read', args: { path: 'src/input.js' } });
  ok('empty authoritative answer removes streamed naming heading', !integrated.st.msgs.some((msg) => msg.role === 'approx'));
  ok('consumed heading lands only on its tool card', integrated.st.msgs.at(-1)?.title === 'Inspect input routing');
  integrated.backendUnsubscribe?.();
  integrated.clock.stop();
}

// ---- backend batch heading names a future 3+ tool group ----
{
  const backend = new PiBackend();
  const events = [];
  backend.subscribe((event) => events.push(event));
  const heading = '### Tool Calls: Audit renderer pipeline\n### Read compositor';
  backend.onPiEvent({ type: 'agent_start' });
  backend.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } });
  backend.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: heading } });
  backend.onPiEvent({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: heading }], stopReason: 'toolUse' },
  });
  backend.onPiEvent({ type: 'tool_execution_start', toolCallId: 'batch-1', toolName: 'read', args: { path: 'src/screen.js' } });
  const end = events.find((event) => event.type === 'assistant_end');
  const start = events.find((event) => event.type === 'tool_start');
  ok('model batch heading is hidden from answer', end?.text === '');
  ok('model batch heading names group level', start?.groupTitle === 'Audit renderer pipeline'
    && start?.groupHeading === 'Tool Calls: Audit renderer pipeline' && start.modelGroupTitle === true);
  ok('batch heading does not replace child title', start?.title === 'Read compositor' && start.modelTitle === true);
}

// A provider that puts titles only in thinking (or omits them) still gets useful
// deterministic action names from the host adapter.
{
  const backend = new PiBackend();
  const events = [];
  backend.subscribe((event) => events.push(event));
  backend.onPiEvent({ type: 'agent_start' });
  backend.onPiEvent({
    type: 'tool_execution_start', toolCallId: 'fallback-find', toolName: 'bash',
    args: { command: 'cd "C:/work/Approx" && find . -type f -not -path "*/node_modules/*"' },
  });
  backend.onPiEvent({
    type: 'tool_execution_start', toolCallId: 'fallback-wc', toolName: 'shell',
    args: { command: 'cd "C:/work/Approx" && echo "files" && wc -l src/*.js' },
  });
  const titles = events.filter((event) => event.type === 'tool_start').map((event) => event.title);
  ok('missing model headings get intent-based tool names', titles.join('|') === 'List project files|Count project lines');
}

// Duplicate visible prompts resolve by ordinal position, never by the last-text fallback.
{
  const backend = new PiBackend();
  backend.session = {
    getUserMessagesForForking: () => [
      { entryId: 'first-same', text: 'same prompt' },
      { entryId: 'second-same', text: 'same prompt' },
    ],
  };
  ok('rewind targets duplicate prompt by visible ordinal', backend.resolveUserEntryAt(0, 'same prompt') === 'first-same'
    && backend.resolveUserEntryAt(1, 'same prompt') === 'second-same');
}

// `/clear` reuses the active session object and rebuilds its live context; `/new`
// is the only path that disposes it and opens another persisted session.
{
  const backend = new PiBackend();
  const overrides = [];
  backend.session = {
    model: { contextWindow: 128000 },
    settingsManager: {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }),
      applyOverrides: (value) => overrides.push(value),
    },
  };
  const percent = backend.setAutoCompactThreshold({ mode: 'percent', percent: 10, tokens: 32768 });
  ok('percent compact threshold maps onto native Pi reserve', percent.thresholdTokens === 12800
    && overrides.at(-1).compaction.reserveTokens === 115200
    && overrides.at(-1).compaction.keepRecentTokens === 6400);
  const tokens = backend.setAutoCompactThreshold({ mode: 'tokens', percent: 80, tokens: 65536 });
  ok('token compact threshold maps onto native Pi reserve', tokens.thresholdTokens === 65536
    && overrides.at(-1).compaction.reserveTokens === 62464
    && overrides.at(-1).compaction.keepRecentTokens === 20000);
}

{
  const backend = new PiBackend();
  let instructions = null;
  backend.session = {
    compact: async (value) => { instructions = value; return { tokensBefore: 64000, estimatedTokensAfter: 12000 }; },
    getContextUsage: () => null,
  };
  const result = await backend.compact('preserve exact paths');
  ok('manual compact delegates to AgentSession', instructions === 'preserve exact paths'
    && result.estimatedTokensAfter === 12000);
}

{
  const c = new App({ noSplash: true });
  c.s = new Screen(new FakeOut(90, 30));
  c.st.contextWindow = 128000;
  c.st.ctxTokens = 96000;
  c.onBackendEvent({ type: 'compaction_start', reason: 'threshold' });
  ok('compact start arms takeover state', c.st.compact.phase === 'running'
    && c.st.compact.enter.target === 1 && c.st.busy);
  c.onBackendEvent({
    type: 'compaction_end', reason: 'threshold', tokensBefore: 96000, estimatedTokensAfter: 18000,
  });
  ok('compact end lands token estimate and releases idle app', c.st.compact.phase === 'done'
    && c.st.compact.tokensAfter === 18000 && Math.abs(c.st.ctxUse.target - 18000 / 128000) < 0.001
    && !c.st.busy);
  c.st.compact.enter.set(1, true);
  c.st.compact.phase = 'running';
  drawCompact(c.s, c.st, 1.5);
  ok('compact progress stays on the primary signal palette', !Array.from(c.s.fg).includes(T.accent2));
  ok('compact veil fully hides transcript outside the panel', c.s.fg[0] === c.s.bg[0]);
  c.st.compact.phase = 'done';
  drawCompact(c.s, c.st, 1.5);
  const compactFrame = c.s.ch.join('');
  ok('compact overlay omits pi link status text', !compactFrame.includes('PI LINK')
    && compactFrame.includes('96K TOK') && compactFrame.includes('18K TOK'));
  let compactThrew = null;
  try {
    c.s.resize(24, 8);
    drawCompact(c.s, c.st, 2);
  } catch (error) { compactThrew = error; }
  ok('compact takeover renders at full and tiny sizes', !compactThrew);
  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}

{
  const backend = new PiBackend();
  let resetLeaf = 0;
  const manager = {
    resetLeaf() { resetLeaf++; },
    buildSessionContext() { return { messages: [] }; },
  };
  const oldSession = {
    isStreaming: false,
    sessionId: 'same-session',
    sessionManager: manager,
    agent: { state: { messages: ['stale'] } },
    getUserMessagesForForking: () => [],
    getContextUsage: () => null,
    model: { provider: 'test', id: 'model-a' },
    thinkingLevel: 'medium',
    dispose() {},
  };
  backend.session = oldSession;
  await backend.resetContext();
  ok('clear rebuilds current live context', resetLeaf === 1 && backend.session === oldSession
    && oldSession.agent.state.messages.length === 0);
  const newSession = { sessionId: 'different-session', sessionFile: 'new.json' };
  backend.openSession = async () => { backend.session = newSession; return newSession; };
  await backend.newConversation();
  ok('new opens a distinct conversation session', backend.session === newSession && backend.session !== oldSession);
}

{
  const backend = new PiBackend();
  let leaf = 'assistant-after-target';
  const target = { id: 'target-user', parentId: 'assistant-before-target', type: 'message', message: { role: 'user' } };
  const prior = {
    id: 'assistant-before-target', type: 'message',
    message: {
      role: 'assistant', content: 'prior',
      details: {
        plan: {
          mode: 'plan', intent: 'Plan before the edited turn', approval: 'pending',
          todos: [{ id: 'before-edit', text: 'Keep the old branch plan', status: 'pending' }],
        },
      },
    },
  };
  const manager = {
    getEntry: (id) => id === target.id ? target : id === prior.id ? prior : { id: leaf },
    getLeafId: () => leaf,
    getBranch: () => [prior],
    buildSessionContext: () => ({ messages: [{ role: 'assistant', content: 'prior' }] }),
  };
  backend.session = {
    isStreaming: false,
    sessionManager: manager,
    agent: { state: { messages: [{ role: 'user', content: 'old prompt' }, { role: 'assistant', content: 'old answer' }] } },
    navigateTree: async () => { leaf = prior.id; return { cancelled: false }; },
    getContextUsage: () => null,
  };
  await backend.rewindContext(target.id);
  ok('rewind rebuilds model context before edited user turn', leaf === prior.id
    && backend.session.agent.state.messages.length === 1
    && backend.session.agent.state.messages[0].content === 'prior');
  ok('rewind restores the Plan snapshot from the destination branch', backend.planState.intent === 'Plan before the edited turn'
    && backend.planState.todos[0]?.id === 'before-edit');
}

{
  const backend = new PiBackend();
  let leaf = 'after-leaf';
  const target = {
    id: 'branch-target', parentId: 'before-leaf', type: 'message', message: { role: 'user' },
  };
  const entries = new Map([
    [target.id, target],
    ['before-leaf', { id: 'before-leaf', type: 'custom', data: {
      plan: { mode: 'plan', intent: 'Before branch', approval: 'pending', todos: [] },
    } }],
    ['after-leaf', { id: 'after-leaf', type: 'custom', data: {
      plan: { mode: 'plan', intent: 'After branch', approval: 'pending', todos: [] },
    } }],
  ]);
  const manager = {
    getEntry: (id) => entries.get(id),
    getLeafId: () => leaf,
    getBranch: () => [entries.get(leaf)],
  };
  backend.session = {
    isStreaming: false,
    sessionManager: manager,
    navigateTree: async (id) => {
      leaf = id === target.id ? target.parentId : id;
      return { cancelled: false };
    },
    getContextUsage: () => null,
  };
  const token = await backend.rewindContext(target.id);
  const rewoundIntent = backend.planState.intent;
  await backend.redoRewind(token);
  ok('rewind and redo restore their respective Plan branches', rewoundIntent === 'Before branch'
    && backend.planState.intent === 'After branch');
}

// ---- backend snapshots Write/Edit and restores both sides of one branch ----
{
  const dir = mkdtempSync(join(tmpdir(), 'approx-rewind-'));
  const file = join(dir, 'fixture.txt');
  writeFileSync(file, 'before', 'utf8');
  const backend = new PiBackend({ cwd: dir });
  const events = [];
  backend.subscribe((event) => events.push(event));
  backend.onPiEvent({ type: 'tool_execution_start', toolCallId: 'edit-1', toolName: 'edit', args: { path: file } });
  writeFileSync(file, 'after', 'utf8');
  backend.onPiEvent({
    type: 'tool_execution_end', toolCallId: 'edit-1', result: { content: [] }, isError: false,
  });
  const mutation = events.find((event) => event.type === 'tool_end')?.mutation;
  ok('backend captures edit preimage and postimage', mutation?.before?.exists && mutation?.after?.exists
    && Buffer.from(mutation.before.data, 'base64').toString() === 'before'
    && Buffer.from(mutation.after.data, 'base64').toString() === 'after');

  const entries = new Map([
    ['user-entry', { id: 'user-entry', type: 'message', message: { role: 'user' } }],
    ['old-leaf', { id: 'old-leaf', type: 'message', message: { role: 'assistant' } }],
  ]);
  backend.session = {
    isStreaming: false,
    sessionManager: { getEntry: (id) => entries.get(id), getLeafId: () => 'old-leaf' },
    navigateTree: async () => ({ cancelled: false, editorText: 'fixture prompt' }),
    getContextUsage: () => null,
  };
  const token = await backend.rewindContext('user-entry', [mutation], ['edit-1']);
  ok('rewind restores file preimage', readFileSync(file, 'utf8') === 'before' && token.oldLeafId === 'old-leaf');
  await backend.redoRewind(token, [mutation]);
  ok('redo restores file postimage', readFileSync(file, 'utf8') === 'after');

  const delivery = new App({ noSplash: true, backend });
  delivery.s = new Screen(new FakeOut(90, 28));
  delivery.push({ role: 'user', text: 'edit through Pi', enter: 1 });
  delivery.push({ role: 'approx', text: 'done', stopReason: 'stop', enter: 1 });
  const deliveryTurn = {
    finalDelivered: true, promiseDone: true, runtimeSettled: true,
    interrupted: false, failed: false, releasing: false,
    mutations: [], mutationCallIds: ['edit-1'],
  };
  delivery._activeTurn = deliveryTurn;
  delivery.tryReleaseTurn(deliveryTurn);
  ok('delivery boundary recovers Pi mutations by tool call id', delivery.st.msgs.at(-1)?.subtype === 'changeset'
    && delivery.st.msgs.at(-1)?.summary?.files === 1);
  delivery.backendUnsubscribe?.();
  delivery.clock.stop();
  rmSync(dir, { recursive: true, force: true });
}

// ---- per-turn FILE CHANGES summary and shared diff model ----
{
  const snapshot = (text, exists = true) => ({
    exists,
    data: exists ? Buffer.from(text).toString('base64') : '',
  });
  const editedPath = join(process.cwd(), 'src', 'fixture-edit.js');
  const newPath = join(process.cwd(), 'src', 'fixture-new.js');
  const deletedPath = join(process.cwd(), 'src', 'fixture-old.js');
  const mutations = [
    { path: editedPath, before: snapshot('alpha\n'), after: snapshot('beta\n') },
    { path: editedPath, before: snapshot('beta\n'), after: snapshot('gamma\n') },
    { path: newPath, before: snapshot('', false), after: snapshot('one\ntwo\n') },
    { path: deletedPath, before: snapshot('gone\n'), after: snapshot('', false) },
  ];
  const files = buildFileChanges(mutations, process.cwd());
  const edited = files.find((file) => file.kind === 'modified');
  const added = files.find((file) => file.kind === 'added');
  const deleted = files.find((file) => file.kind === 'deleted');
  ok('turn mutations merge first preimage into final postimage', files.length === 3
    && edited.added === 1 && edited.removed === 1
    && edited.diff.some((line) => line.kind === 'del' && line.text === 'alpha')
    && edited.diff.some((line) => line.kind === 'add' && line.text === 'gamma'));
  ok('file change model counts new and deleted lines', added.added === 2 && deleted.removed === 1);
  ok('diff rows carry old and new line numbers', edited.diff.some((line) => line.kind === 'del' && line.oldLine === 1)
    && edited.diff.some((line) => line.kind === 'add' && line.newLine === 1));

  const changesApp = new App({ noSplash: true });
  changesApp.s = new Screen(new FakeOut(100, 40));
  changesApp.push({ role: 'user', text: 'change files', enter: 1 });
  changesApp.push({ role: 'approx', text: 'Done.', stopReason: 'stop', enter: 1 });
  const turn = {
    finalDelivered: true, promiseDone: true, runtimeSettled: true,
    interrupted: false, failed: false, releasing: false, mutations,
  };
  changesApp._activeTurn = turn;
  changesApp.tryReleaseTurn(turn);
  const changeset = changesApp.st.msgs.at(-1);
  changeset.enter = 1;
  ok('completed turn appends SYSTEM changes after final APPROX', changesApp.st.msgs.map((msg) => `${msg.role}:${msg.subtype || ''}`).join('|')
    === 'user:|approx:|system:changeset');
  ok('FILE CHANGES starts collapsed with aggregate counts', visibleLines(changeset, 80).length === 1
    && changeset.summary.files === 3 && changeset.summary.added === 3 && changeset.summary.removed === 2);
  changesApp.onKey({ name: 'u', ctrl: true });
  const keyboardExpanded = changeset.expanded;
  changeset.expandAnim.set(1, true);
  ok('keyboard expands focused FILE CHANGES', keyboardExpanded
    && visibleLines(changeset, 80).some((line) => line.kind === 'changediff'));
  changesApp.onKey({ name: 'u', ctrl: true });
  changesApp.st.scroll = 0;
  changesApp.st.scrollTarget = 0;
  changesApp.render(0);
  const vp = changesApp.viewport();
  const docTop = changesApp.st.msgs.slice(0, -1).reduce((sum, msg) => sum + totalHeight([msg], changesApp.bodyWidth()), 0);
  changesApp.onKey({ name: 'mousedown', mouse: true, x: vp.x + 4, y: vp.y + docTop + 1 });
  ok('clicking FILE CHANGES header expands it', changeset.expanded);

  const transcriptScreen = new Screen(new FakeOut(100, 40));
  transcriptScreen.clear(T.bg, T.fg);
  changeset.expandAnim.set(1, true);
  drawTranscript(transcriptScreen, [changeset], 0, 0, 100, 40, 0, 0);
  ok('new file uses green solid diff rail', transcriptScreen.ch.some((ch, index) => ch === '┃' && transcriptScreen.fg[index] === T.ok));
  ok('deleted file uses red dashed diff rail', transcriptScreen.ch.some((ch, index) => ch === '╎' && transcriptScreen.fg[index] === T.accent));
  const changeSnapshot = changesApp.snapshot().at(-1);
  ok('snapshot preserves expandable FILE CHANGES diff', changeSnapshot.subtype === 'changeset'
    && changeSnapshot.files.length === 3 && changeSnapshot.files[0].diff.length > 0);

  const quietApp = new App({ noSplash: true });
  quietApp.push({ role: 'user', text: 'read only', enter: 1 });
  quietApp.push({ role: 'approx', text: 'No edits.', stopReason: 'stop', enter: 1 });
  const quietTurn = {
    finalDelivered: true, promiseDone: true, runtimeSettled: true,
    interrupted: false, failed: false, releasing: false, mutations: [],
  };
  quietApp._activeTurn = quietTurn;
  quietApp.tryReleaseTurn(quietTurn);
  ok('read-only turn does not add an empty FILE CHANGES row', !quietApp.st.msgs.some((msg) => msg.subtype === 'changeset'));
  changesApp.clock.stop();
  quietApp.clock.stop();
}

// ---- Git workbench status, operations, and responsive render ----
{
  const parsed = parseGitStatus('## main...origin/main [ahead 2, behind 1]\0 M src/a.js\0A  src/new.js\0R  src/to.js\0src/from.js\0?? loose.txt\0');
  ok('git status parser keeps branch divergence', parsed.branch.name === 'main'
    && parsed.branch.upstream === 'origin/main' && parsed.branch.ahead === 2 && parsed.branch.behind === 1);
  ok('git status parser splits worktree and staged lanes', parsed.worktree.length === 2 && parsed.staged.length === 2
    && parsed.staged.find((file) => file.mark === 'R')?.originalPath === 'src/from.js');

  const gitApp = new App({ noSplash: true });
  gitApp.s = new Screen(new FakeOut(100, 30));
  gitApp.st.git.anim.set(1, true);
  gitApp.st.git.branch = parsed.branch;
  gitApp.st.git.lanes = [parsed.worktree, parsed.staged];
  gitApp.st.git.commits = [{ hash: 'abc1234', subject: 'Make Git visual', age: 'now' }];
  gitApp.st.git.diffPath = 'src/a.js';
  gitApp.st.git.diff = [
    { kind: 'hunk', text: '@@ -1,1 +1,1 @@', oldLine: null, newLine: null },
    { kind: 'del', text: 'old', oldLine: 1, newLine: null },
    { kind: 'add', text: 'new', oldLine: null, newLine: 1 },
  ];
  gitApp.s.clear(T.bg, T.fg);
  drawGit(gitApp.s, gitApp.st, 0.4);
  const gitFrame = gitApp.s.ch.join('');
  ok('Git workbench renders lanes, index gate, and numbered diff', gitFrame.includes('WORKTREE')
    && gitFrame.includes('STAGED') && gitFrame.includes('INDEX') && gitFrame.includes('src/a.js'));
  ok('Git workbench translates untracked question marks into a green add marker', !gitFrame.includes('??')
    && gitFrame.includes('+  loose.txt'));
  ok('Git workbench exposes mouse targets', gitApp.st.git.hits.some((hit) => hit.kind === 'file')
    && gitApp.st.git.hits.some((hit) => hit.kind === 'gate') && gitApp.st.git.hits.some((hit) => hit.kind === 'commit'));
  let narrowGitThrew = false;
  try {
    const narrow = new Screen(new FakeOut(24, 9));
    narrow.clear(T.bg, T.fg);
    drawGit(narrow, gitApp.st, 0.6);
  } catch {
    narrowGitThrew = true;
  }
  ok('Git workbench renders in a narrow terminal', !narrowGitThrew);

  const repo = mkdtempSync(join(tmpdir(), 'approx-git-'));
  const run = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  run(['init', '-q']);
  run(['config', 'user.email', 'approx@example.test']);
  run(['config', 'user.name', 'Approx Test']);
  writeFileSync(join(repo, 'tracked.txt'), 'base\n', 'utf8');
  run(['add', 'tracked.txt']);
  run(['commit', '-q', '-m', 'base']);
  writeFileSync(join(repo, 'tracked.txt'), 'changed\n', 'utf8');
  gitApp.st.cwdPath = repo;
  await gitApp.refreshGit();
  ok('Git refresh reads worktree diff', gitApp.st.git.lanes[0][0]?.path === 'tracked.txt'
    && gitApp.st.git.diff.some((line) => line.kind === 'add' && line.text === 'changed'));
  await gitApp.gitStageAll();
  ok('Git stage-all moves changes through the index gate', gitApp.st.git.lanes[0].length === 0
    && gitApp.st.git.lanes[1][0]?.path === 'tracked.txt');
  await gitApp.gitUnstageAll();
  ok('Git unstage-all returns changes to worktree', gitApp.st.git.lanes[1].length === 0
    && gitApp.st.git.lanes[0][0]?.path === 'tracked.txt');
  rmSync(repo, { recursive: true, force: true });
  gitApp.clock.stop();
}

// ---- harness bridge: NDJSON drive ----
{
  class FakeIn {
    setEncoding() {}
    resume() {}
    on(ev, fn) { (this._h ??= {})[ev] = fn; }
    off() {}
    emit(ev, d) { this._h?.[ev]?.(d); }
  }
  const evs = [];
  const evOut = { write(s) { for (const l of s.split('\n')) if (l.trim()) evs.push(JSON.parse(l)); return true; } };
  const c = new App({ noSplash: true, harness: true });
  c.s = new Screen(new FakeOut(80, 24));
  c.seed();
  const fin = new FakeIn();
  const h = new Harness(c, { input: fin, out: evOut });
  c.attachHarness(h);
  const send = (o) => fin.emit('data', JSON.stringify(o) + '\n');
  const last = (evt) => [...evs].reverse().find((e) => e.event === evt);

  ok('harness announces ready', evs.some((e) => e.event === 'ready'));

  // attached backend: a submit emits needReply instead of running the script
  send({ cmd: 'attach' });
  ok('harness attaches', h.attached);
  send({ cmd: 'submit', text: 'drive me' });
  ok('harness submit lands a user turn', c.st.msgs.some((m) => m.role === 'user' && m.text === 'drive me'));
  ok('harness attached emits needReply', last('needReply')?.text === 'drive me');
  ok('harness attached suppresses scripted reply', !c.timers.size || ![...c.st.msgs].some((m) => m.streaming));

  // driver streams the reply; the real renderer runs it
  send({ cmd: 'say', text: 'a driven answer', cps: 2000 });
  ok('harness say begins a stream', c.st.msgs[c.st.msgs.length - 1].streaming);
  for (let i = 0; i < 120; i++) c.tick(1 / 30, i / 30, i);
  ok('harness stream finishes', last('streamEnd') != null);

  // set write-through echoes a setting event and mutates state
  send({ cmd: 'set', key: 'autoCompactMode', value: 'tokens' });
  ok('harness set applies', c.st.autoCompactMode === 'tokens' && last('setting')?.key === 'autoCompactMode');

  // tool injection runs and reports
  send({ cmd: 'tool', name: 'grep', meta: 'src', text: 'searching', dur: 60 });
  ok('harness tool pushes a running tool', c.st.msgs.some((m) => m.role === 'tool' && m.running));

  // snapshot + frame are pull-only introspection
  send({ cmd: 'snapshot' });
  ok('harness snapshot returns transcript', Array.isArray(last('snapshot')?.msgs));
  send({ cmd: 'frame', cols: 50, rows: 10 });
  const fr = last('frame');
  ok('harness frame dumps ansi at size', fr?.cols === 50 && fr?.rows === 10 && fr.ansi.length > 100);

  // bad json and unknown commands surface as errors, don't throw
  h.feed('{not json}\n');
  ok('harness bad json errors', last('error')?.message === 'bad json');
  send({ cmd: 'nope' });
  ok('harness unknown cmd errors', last('error')?.message.includes('nope'));

  send({ cmd: 'ping' });
  ok('harness ping pongs', last('pong') != null);

  // detach hands the backend back: submit runs the script again
  send({ cmd: 'detach' });
  ok('harness detaches', !h.attached);

  h.stop();
  c.clock.stop();
  for (const id of c.timers) clearTimeout(id);
}

// stop timers so the process can exit
app.clock.stop();
for (const id of app.timers) clearTimeout(id);
process.stdout.columns = realCols;
process.stdout.rows = realRows;

// ---- report ----
if (appThrew) console.error('\napp error:', appThrew.stack);
if (splashThrew) console.error('\nsplash error:', splashThrew.stack);
console.log(`\napprox smoke: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
process.exit(0);
