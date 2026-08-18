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
  createApproxHostTools, createApprodeState, approdeRows, navigableRows, APPRODE_MAX_PRESETS,
  loadPreferences, savePreferences, Harness, App, createAppState, PiBackend,
  toolMessages, T, paper, drawPaperGrain,
  EventEmitter, spawnSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
  tmpdir, join, SAMPLE_LONG, ok, recordError, FakeOut,
} = smoke;
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

  // The model may request a hot-swap, but only the user can commit it.
  const asked = [];
  let decision = 'approve';
  const swaps = [];
  const approdeHost = {
    requestQuestions: (id, questions, _signal, opts) => {
      asked.push({ questions, opts });
      return Promise.resolve({ answers: [{ id: questions[0].id, value: decision }] });
    },
    applyApprodeFromModel: (payload) => { swaps.push(payload); return Promise.resolve({ disabledSkills: [] }); },
  };
  const approdeTool = createApproxHostTools(approdeHost).find((tool) => tool.name === 'manage_approde');
  ok('Pi exposes manage_approde with a required reason', approdeTool
    && approdeTool.parameters.required.includes('reason')
    && approdeTool.parameters.properties.enableSkills
    && approdeTool.parameters.properties.disablePrompts);

  const approved = await approdeTool.execute('call-1', { reason: 'need charts', enableSkills: ['dataviz'] });
  ok('an approved model request routes through the questionnaire and applies',
    asked[0].opts.title === 'APPRODE CHANGE REQUEST'
    && asked[0].questions[0].prompt.includes('dataviz')
    && asked[0].questions[0].prompt.includes('need charts')
    && swaps.length === 1 && swaps[0].enableSkills.join(',') === 'dataviz'
    && approved.details.applied === true);

  decision = 'reject';
  const rejected = await approdeTool.execute('call-2', { reason: 'tidy up', disableSkills: ['grilling'] });
  ok('a rejected model request leaves the active set untouched',
    swaps.length === 1 && rejected.details.applied === false);

  const empty = await approdeTool.execute('call-3', { reason: 'no-op' });
  ok('a model request with no changes never prompts the user',
    asked.length === 2 && empty.details.applied === false);
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

  const locked = questionsApp.openQuestionnaire({ questions: [{
    id: 'locked', type: 'single', prompt: 'Provider', allowOther: false,
    options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }],
  }] });
  ok('locked choice questions omit Something else', questionsApp.st.questionnaire.questions[0].options.length === 2
    && !questionsApp.st.questionnaire.questions[0].options.some((option) => option.label === 'Something else'));
  questionsApp.questionnaireBack();
  const lockedResult = await locked;
  ok('questionnaire Back on first step cancels cleanly', lockedResult.cancelled && lockedResult.reason === 'back');

  const effortApp = new App({ noSplash: true });
  effortApp.s = new Screen(new FakeOut(84, 22));
  effortApp.st.effortOptions = ['low', 'medium', 'high', 'xhigh'];
  effortApp.st.effort = 'medium';
  const effortPromise = effortApp.openEffortPicker();
  ok('/effort opens its dedicated horizontal level panel', effortApp.st.effortPicker.open
    && effortApp.st.effortPicker.options.length === 4
    && !effortApp.st.questionnaire.open);
  effortApp.st.effortPicker.anim.set(1, true);
  effortApp.render(0.25);
  effortApp.s.flush();
  const effortFrame = effortApp.s.ch.join('');
  ok('effort panel renders the themed speed-to-depth spectrum', effortFrame.includes('EFFORT / LEVEL')
    && effortFrame.includes('FASTER / QUICK') && effortFrame.includes('SMARTER / DEEP')
    && effortApp.s.out.buf.includes(HIDE_CURSOR));
  effortApp.onKey({ name: 'right' });
  ok('effort arrows preview without immediately applying', effortApp.st.effortPicker.index === 2
    && effortApp.st.effort === 'medium');
  effortApp.onKey({ name: 'enter' });
  const appliedEffort = await effortPromise;
  ok('/effort applies the previewed model level', appliedEffort.applied && effortApp.st.effort === 'high');

  const cancelPromise = effortApp.openEffortPicker();
  effortApp.onKey({ name: 'left' });
  effortApp.onKey({ name: 'escape' });
  const cancelledEffort = await cancelPromise;
  ok('effort Escape cancels a preview cleanly', !cancelledEffort.applied && effortApp.st.effort === 'high');

  const pointerPromise = effortApp.openEffortPicker();
  effortApp.st.effortPicker.anim.set(1, true);
  effortApp.render(0.3);
  const xhighHit = effortApp.st.effortPicker.hits.find((hit) => hit.kind === 'option' && hit.index === 3);
  effortApp.effortPickerPointer(Math.floor((xhighHit.x1 + xhighHit.x2) / 2), xhighHit.y2, false);
  const applyHit = effortApp.st.effortPicker.hits.find((hit) => hit.kind === 'apply');
  effortApp.effortPickerPointer(applyHit.x1, applyHit.y1, true);
  await pointerPromise;
  ok('effort mouse targets preview and apply a level', effortApp.st.effort === 'xhigh');

  effortApp.s = new Screen(new FakeOut(28, 9));
  const narrowEffort = effortApp.openEffortPicker();
  effortApp.st.effortPicker.anim.set(1, true);
  let narrowEffortThrew = false;
  try { effortApp.render(0.35); } catch { narrowEffortThrew = true; }
  ok('effort panel stays bounded in a narrow terminal', !narrowEffortThrew
    && effortApp.st.effortPicker.geometry.w <= 26
    && effortApp.st.effortPicker.geometry.h <= 9);
  effortApp.onKey({ name: 'escape' });
  await narrowEffort;

  const scenicApp = new App({ noSplash: true });
  scenicApp.s = new Screen(new FakeOut(84, 22));
  scenicApp.st.effortOptions = ['low', 'high', 'xhigh', 'max'];
  scenicApp.st.effort = 'high';
  const scenicPromise = scenicApp.openEffortPicker();
  const scenic = scenicApp.st.effortPicker;
  scenic.anim.set(1, true);
  scenicApp.render(0);
  const fingerprint = () => [scenicApp.s.ch.join('\u0001'), scenicApp.s.copyCh.join('\u0001'),
    Array.from(scenicApp.s.fg).join(','), Array.from(scenicApp.s.bg).join(','), Array.from(scenicApp.s.at).join(',')].join('|');
  const highFrame = fingerprint();
  const highRow = scenicApp.s.ch.slice((scenic.geometry.y + 4) * scenicApp.s.w, (scenic.geometry.y + 5) * scenicApp.s.w);
  const highX = highRow.indexOf('h');
  ok('high is a bold silver label on a black starlit chip', highX >= 0
    && scenicApp.s.bg[(scenic.geometry.y + 4) * scenicApp.s.w + highX] === T.pitch
    && (scenicApp.s.at[(scenic.geometry.y + 4) * scenicApp.s.w + highX] & 1) === 1);
  scenicApp.moveEffortPicker(1);
  scenicApp.render(0.1);
  const firstXhigh = fingerprint();
  scenic.fade.set(0.25, true);
  scenicApp.render(0.2);
  const middleXhigh = fingerprint();
  scenic.fade.set(1, true);
  scenicApp.render(0.3);
  const finalXhigh = fingerprint();
  const xhighInterior = (scenic.geometry.y + 1) * scenicApp.s.w + scenic.geometry.x + 1;
  ok('high to xhigh crossfade starts on the old frame, changes midway, then reaches the black meteor sky',
    firstXhigh === highFrame && middleXhigh !== highFrame && finalXhigh !== highFrame
    && scenicApp.s.bg[xhighInterior] === T.pitch && scenicApp.s.ch.join('').includes('╌') && scenicApp.s.ch.join('').includes('✧'));
  scenicApp.moveEffortPicker(1);
  scenic.fade.set(0.3, true);
  scenicApp.render(0.4);
  const visibleMiddle = fingerprint();
  scenicApp.moveEffortPicker(0, 'start');
  scenicApp.render(0.5);
  ok('a Home move during xhigh to max begins from the visible intermediate frame', fingerprint() === visibleMiddle && scenic.index === 0);
  scenic.fade.set(1, true);
  scenicApp.moveEffortPicker(0, 'end');
  scenic.fade.set(1, true);
  scenicApp.render(0.7);
  ok('max expands to a meteor sky and animated multi-tone ocean', scenic.geometry.h > 9
    && scenicApp.s.ch.join('').includes('Cinematic maximum reasoning')
    && scenicApp.s.ch.join('').includes('≈') && scenicApp.s.ch.join('').includes('╲'));
  scenicApp.st.reduceMotion = true;
  const beforeReduced = fingerprint();
  scenicApp.moveEffortPicker(0, 'start');
  scenicApp.render(1);
  ok('reduced motion switches immediately and discards transition snapshots', scenic.snapshot === null && scenic.fade.settled
    && fingerprint() !== beforeReduced && scenic.index === 0);
  scenicApp.closeEffortPicker(false, 'test');
  await scenicPromise;
  scenicApp.clock.stop();

  effortApp.s = new Screen(new FakeOut(84, 22));
  effortApp.openSettings();
  const effortSettingIndex = settingsRows(settingsModel(effortApp)).findIndex((item) => item.key === 'effort');
  effortApp.st.settingsIndex = effortSettingIndex;
  effortApp.settingsKey({ name: 'enter' });
  ok('Settings opens the same effort spectrum', effortApp.st.effortPicker.open);
  effortApp.closeEffortPicker(false, 'test');
  effortApp.clock.stop();

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

// ---- approde: hot-swappable skills and prompts ----
{
  const malformed = createApprodeState({
    disabledSkills: 'legacy-skill',
    disabledPrompts: { old: true },
    presets: [{ name: 'legacy', disabledSkills: 'legacy-skill', disabledPrompts: null }],
  });
  ok('malformed approde preferences normalize to empty arrays instead of crashing startup',
    !malformed.disabledSkills.size && !malformed.disabledPrompts.size
    && !malformed.presets[0].disabledSkills.length && !malformed.presets[0].disabledPrompts.length);

  const app = new App({ noSplash: true });
  app.s = new Screen(new FakeOut(120, 30));
  const applied = [];
  app.backend = {
    getResourceCatalog: () => ({
      skills: [{ name: 'dataviz', description: 'charts' }, { name: 'grilling', description: 'stress-test' }],
      prompts: [{ name: 'review', description: 'code review' }],
    }),
    serializeApprode: () => ({ disabledSkills: [], disabledPrompts: [], activePreset: '' }),
    applyApprodeSelection: (payload) => { applied.push(payload); return Promise.resolve(); },
  };

  app.onKey({ ctrl: true, name: 'b' });
  ok('ctrl+b opens the approde sidebar with the live catalog', app.st.approde.open
    && app.st.approde.focused
    && app.st.approde.catalog.skills.length === 2
    && app.st.approde.catalog.prompts.length === 1);

  const fullBody = app.bodyWidth();
  app.st.approde.anim.set(1, true);
  app.render(0.2);
  ok('an open sidebar compresses the transcript instead of overpainting it',
    app.bodyWidth() < fullBody && app.approdeGutter() >= 32);
  const geom = app.st.approde.geometry;
  const vp = app.viewport();
  ok('the drawer docks to the right edge across the transcript band',
    geom && geom.x + geom.w === app.s.w && geom.y === vp.y && geom.h === vp.h);
  const frame = app.s.ch.join('');
  ok('the sidebar renders its stencil chrome and catalog', frame.includes('APPRODE')
    && frame.includes('HOT-SWAP') && frame.includes('PRESETS') && frame.includes('SKILLS')
    && frame.includes('dataviz') && frame.includes('Apply & re-work'));

  const skillRow = app.st.approde.hits.find((hit) => hit.kind === 'skill');
  app.approdePointer(skillRow.x1 + 2, skillRow.y1, true);
  ok('clicking a skill row disables it and diverges from any preset',
    app.st.approde.disabledSkills.size === 1 && app.st.approde.dirty && !app.st.approde.activePreset);

  app.onKey({ name: 's' });
  for (const ch of 'lean') app.onKey({ name: ch, printable: true });
  app.onKey({ name: 'enter' });
  ok('S names and saves the current set as a preset', app.st.approde.presets.length === 1
    && app.st.approde.presets[0].name === 'lean'
    && app.st.approde.presets[0].disabledSkills.length === 1
    && app.st.approde.activePreset === 'lean' && !app.st.approde.dirty
    && app.st.approde.mode === 'browse');

  await app.resetApprode();
  ok('Enable everything clears the disabled sets and re-works', !app.st.approde.disabledSkills.size
    && applied.at(-1)?.rework === true && applied.at(-1)?.disabledSkills.length === 0);

  await app.applyApprodePreset('lean');
  ok('re-applying a saved preset restores its disabled set',
    app.st.approde.activePreset === 'lean'
    && [...app.st.approde.disabledSkills].join(',') === applied.at(-1).disabledSkills.join(',')
    && applied.at(-1).presetLabel === 'lean');

  ok('presets and the active set persist into preferences', (() => {
    app.persistenceEnabled = true;
    app.persistPreferences();
    const seed = app.preferences.approde;
    app.persistenceEnabled = false;
    const restored = createApprodeState(seed);
    return restored.presets.length === 1 && restored.presets[0].name === 'lean'
      && restored.activePreset === 'lean' && restored.disabledSkills.size === 1;
  })());

  const cappedApp = new App({ noSplash: true });
  cappedApp.s = new Screen(new FakeOut(100, 28));
  for (let i = 1; i <= APPRODE_MAX_PRESETS; i++) cappedApp.saveApprodePreset(`preset-${i}`);
  const overflowSaved = cappedApp.saveApprodePreset('preset-overflow');
  const cappedRoundTrip = createApprodeState({ presets: cappedApp.st.approde.presets });
  ok('preset creation enforces the same cap used during preference hydration',
    overflowSaved === false && cappedApp.st.approde.presets.length === APPRODE_MAX_PRESETS
    && cappedRoundTrip.presets.length === APPRODE_MAX_PRESETS
    && !cappedRoundTrip.presets.some((preset) => preset.name === 'preset-overflow'));

  const failedApp = new App({ noSplash: true });
  failedApp.s = new Screen(new FakeOut(100, 28));
  failedApp.backend = {
    getResourceCatalog: () => ({ skills: [{ name: 'dataviz' }], prompts: [] }),
    serializeApprode: () => ({ disabledSkills: [], disabledPrompts: [], activePreset: '' }),
    applyApprodeSelection: () => Promise.reject(new Error('reload failed')),
  };
  failedApp.toggleApprodeSkill('dataviz');
  const failedResult = await failedApp.applyApprode();
  failedApp.openApprode();
  ok('a rejected apply remains dirty and preserves the pending selection for retry',
    failedResult === false && failedApp.st.approde.dirty && !failedApp.st.approde.applying
    && failedApp.st.approde.disabledSkills.has('dataviz') && failedApp.st.toast === 'reload failed');

  // A backend-pushed change (model request approved, or startup) re-hydrates the panel.
  app.applyApprodeEvent({
    catalog: { skills: [{ name: 'dataviz' }, { name: 'grilling' }], prompts: [{ name: 'review' }] },
    state: { disabledSkills: ['grilling'], disabledPrompts: ['review'], activePreset: 'model-set' },
    reason: 'model',
  });
  ok('a backend approde event re-hydrates the sidebar state', app.st.approde.activePreset === 'model-set'
    && app.st.approde.disabledPrompts.has('review') && !app.st.approde.dirty);

  app.onKey({ name: 'escape' });
  ok('escape collapses the sidebar and returns the columns', !app.st.approde.open
    && !app.st.approde.focused);
  app.st.approde.anim.set(0, true);
  ok('a collapsed sidebar costs no width', app.approdeGutter() === 0 && app.bodyWidth() === fullBody);

  // Startup default: re-arm the last active preset without triggering a re-work turn.
  const resumeApp = new App({ noSplash: true });
  resumeApp.s = new Screen(new FakeOut(100, 28));
  const resumed = [];
  resumeApp.st.approde = createApprodeState({
    presets: [{ name: 'lean', disabledSkills: ['dataviz'], disabledPrompts: [] }],
    activePreset: 'lean',
    disabledSkills: ['dataviz'],
  });
  resumeApp.backend = { applyApprodeSelection: (payload) => { resumed.push(payload); return Promise.resolve(); } };
  await resumeApp.resumeLastApprode();
  ok('startup restores the last active preset without a re-work turn', resumed.length === 1
    && resumed[0].presetLabel === 'lean' && resumed[0].rework === false
    && resumed[0].disabledSkills.join(',') === 'dataviz');

  const readyApp = new App({ noSplash: true });
  readyApp.s = new Screen(new FakeOut(100, 28));
  readyApp.st.approde = createApprodeState({
    presets: [{ name: 'lean', disabledSkills: ['dataviz'], disabledPrompts: [] }],
    activePreset: 'lean',
    disabledSkills: ['dataviz'],
  });
  const readyRestores = [];
  readyApp.backend = {
    applyApprodeSelection: (payload) => { readyRestores.push(payload); return Promise.resolve(); },
  };
  readyApp.onBackendEvent({
    type: 'ready', runtime: 'Approx test', models: [], effortOptions: [],
    approde: {
      catalog: { skills: [{ name: 'dataviz' }], prompts: [] },
      state: { disabledSkills: [], disabledPrompts: [], activePreset: '' },
    },
  });
  await Promise.resolve();
  ok('ready preserves the saved selection before pushing it into a fresh backend',
    readyApp.st.approde.activePreset === 'lean'
    && readyApp.st.approde.disabledSkills.has('dataviz')
    && readyRestores.length === 1 && readyRestores[0].rework === false);

  const narrowApp = new App({ noSplash: true });
  narrowApp.s = new Screen(new FakeOut(77, 24));
  narrowApp.onKey({ ctrl: true, name: 'b' });
  narrowApp.onKey({ name: 'x', printable: true });
  ok('a narrow terminal rejects the invisible drawer and leaves composer input usable',
    !narrowApp.st.approde.open && !narrowApp.st.approde.focused && narrowApp.st.input === 'x');

  narrowApp.s.resize(120, 30);
  narrowApp.openApprode();
  narrowApp.s.resize(77, 24);
  narrowApp.closeApprodeForNarrowScreen();
  ok('an open drawer closes immediately when a resize crosses the width threshold',
    !narrowApp.st.approde.open && !narrowApp.st.approde.focused);

  narrowApp.clock.stop();
  readyApp.clock.stop();
  failedApp.clock.stop();
  cappedApp.clock.stop();
  resumeApp.clock.stop();
  app.clock.stop();
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
