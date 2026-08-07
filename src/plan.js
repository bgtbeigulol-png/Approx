import { Spring, clamp } from './anim.js';
import { cleanText, finiteInt } from './value-utils.js';

export const PLAN_MODES = ['go', 'plan'];
export const PLAN_APPROVALS = ['none', 'draft', 'pending', 'approved', 'rejected'];
export const TODO_STATES = ['pending', 'in_progress', 'completed'];

const MAX_TODOS = 64;
const MAX_TEXT = 12_000;
const MAX_TODO_NOTE = 4_000;

/** Conversation-scoped Plan state. Springs and hit targets are UI-only. */
export function createPlanState(seed = {}) {
  const mode = normalizeMode(seed.mode);
  const state = {
    mode,
    intent: cleanText(seed.intent),
    proposal: cleanText(seed.proposal ?? seed.plan),
    todos: normalizeTodos(seed.todos),
    notes: cleanText(seed.notes),
    approval: normalizeApproval(seed.approval, mode),
    closed: !!seed.closed,
    completedAt: finiteInt(seed.completedAt, 0),
    expanded: seed.expanded !== false,
    focused: false,
    cursor: 0,
    revision: finiteInt(seed.revision, 0),
    nextTodoId: 1,
    updatedAt: finiteInt(seed.updatedAt, Date.now()),
    source: cleanText(seed.source, 80) || 'local',
    anim: new Spring(0, { stiff: 19, damp: 0.86 }),
    pulse: new Spring(0, { stiff: 16, damp: 0.78 }),
    cursorAnim: new Spring(0, { stiff: 22, damp: 0.9 }),
    drag: null,
    hits: [],
    geometry: null,
  };
  state.nextTodoId = nextTodoSequence(state.todos);
  state.cursor = clamp(finiteInt(seed.cursor, 0), 0, Math.max(0, state.todos.length - 1));
  state.cursorAnim.set(state.cursor, true);
  state.anim.set(planShouldShow(state) ? 1 : 0, true);
  return state;
}

/** JSON-safe state for backend events, session entries, and snapshots. */
export function serializePlanState(state) {
  const plan = state ?? createPlanState();
  return {
    mode: normalizeMode(plan.mode),
    intent: cleanText(plan.intent),
    proposal: cleanText(plan.proposal),
    todos: normalizeTodos(plan.todos).map(({ id, text, note, status }) => ({
      id, text, note, status, done: status === 'completed',
    })),
    notes: cleanText(plan.notes),
    approval: normalizeApproval(plan.approval, plan.mode),
    closed: !!plan.closed,
    completedAt: finiteInt(plan.completedAt, 0),
    expanded: plan.expanded !== false,
    revision: finiteInt(plan.revision, 0),
    updatedAt: finiteInt(plan.updatedAt, Date.now()),
    source: cleanText(plan.source, 80) || 'local',
  };
}

export function hydratePlanState(snapshot, current = null) {
  const next = createPlanState(snapshot);
  if (!current) return next;
  next.anim = current.anim ?? next.anim;
  next.pulse = current.pulse ?? next.pulse;
  next.cursorAnim = current.cursorAnim ?? next.cursorAnim;
  next.drag = current.drag ?? null;
  next.focused = !!current.focused;
  next.cursor = clamp(current.cursor ?? 0, 0, Math.max(0, next.todos.length - 1));
  next.cursorAnim.set(next.cursor, true);
  next.anim.set(planShouldShow(next) ? 1 : 0);
  return next;
}

export function planShouldShow(plan) {
  return !!plan && !plan.closed
    && (plan.mode === 'plan' || plan.todos?.length || plan.intent || plan.proposal);
}

/**
 * Apply the same operation shape used by the model-facing plan tool. The function
 * mutates `state` so an extension closure can keep one branch-aware live object.
 */
export function applyPlanOperation(state, input = {}) {
  const plan = state ?? createPlanState();
  const action = String(input.action ?? input.operation ?? 'update').toLowerCase();
  let contentChanged = false;

  switch (action) {
    case 'mode':
    case 'set_mode':
      plan.mode = normalizeMode(input.mode ?? input.value);
      if (plan.mode === 'plan') {
        if (plan.approval === 'none') plan.approval = 'draft';
        plan.closed = false;
      }
      break;
    case 'propose':
    case 'replace':
      if ('intent' in input) plan.intent = cleanText(input.intent);
      if ('proposal' in input || 'plan' in input) plan.proposal = cleanText(input.proposal ?? input.plan);
      if ('todos' in input) plan.todos = normalizeTodos(input.todos);
      if ('notes' in input) plan.notes = cleanText(input.notes);
      plan.mode = 'plan';
      plan.approval = input.approval ? normalizeApproval(input.approval, 'plan') : 'pending';
      contentChanged = true;
      break;
    case 'add':
    case 'add_todo': {
      const text = cleanText(input.text ?? input.todo, 2_000);
      if (text && plan.todos.length < MAX_TODOS) {
        const id = uniqueTodoId(plan, input.id);
        plan.todos.push({
          id,
          text,
          note: cleanText(input.note ?? input.comment, MAX_TODO_NOTE),
          status: normalizeTodoStatus(input.status),
        });
        plan.cursor = plan.todos.length - 1;
        contentChanged = true;
      }
      break;
    }
    case 'edit':
    case 'update_todo': {
      const todo = findTodo(plan, input.id ?? input.index);
      if (todo) {
        if ('text' in input) todo.text = cleanText(input.text, 2_000) || todo.text;
        if ('note' in input || 'comment' in input) {
          todo.note = cleanText(input.note ?? input.comment, MAX_TODO_NOTE);
        }
        if ('status' in input || 'done' in input) {
          todo.status = input.done === true ? 'completed'
            : input.done === false ? 'pending' : normalizeTodoStatus(input.status);
        }
        contentChanged = true;
      }
      break;
    }
    case 'complete':
    case 'complete_todo':
    case 'toggle':
    case 'toggle_todo': {
      const todo = findTodo(plan, input.id ?? input.index);
      if (todo) {
        if (action === 'toggle' || action === 'toggle_todo') {
          todo.status = todo.status === 'completed' ? 'pending' : 'completed';
        } else {
          todo.status = input.completed === false ? 'pending' : 'completed';
        }
        contentChanged = true;
      }
      break;
    }
    case 'remove':
    case 'remove_todo': {
      const index = findTodoIndex(plan, input.id ?? input.index);
      if (index >= 0) {
        plan.todos.splice(index, 1);
        plan.cursor = clamp(plan.cursor, 0, Math.max(0, plan.todos.length - 1));
        contentChanged = true;
      }
      break;
    }
    case 'move':
    case 'move_todo':
    case 'reorder_todo': {
      const from = findTodoIndex(plan, input.id ?? input.from);
      if (from >= 0 && plan.todos.length > 1) {
        const requested = Number.isInteger(input.to)
          ? input.to : from + finiteInt(input.offset, 0);
        const to = clamp(requested, 0, plan.todos.length - 1);
        if (to !== from) {
          const [todo] = plan.todos.splice(from, 1);
          plan.todos.splice(to, 0, todo);
          plan.cursor = to;
          contentChanged = true;
        }
      }
      break;
    }
    case 'clear':
    case 'clear_todos':
      plan.todos = [];
      plan.cursor = 0;
      contentChanged = true;
      break;
    case 'notes':
    case 'set_notes':
      plan.notes = cleanText(input.notes ?? input.text);
      contentChanged = true;
      break;
    case 'approval':
    case 'set_approval':
      plan.approval = normalizeApproval(input.approval ?? input.value, plan.mode);
      break;
    case 'visibility':
    case 'set_visibility':
      plan.expanded = input.expanded !== false && input.hidden !== true;
      break;
    case 'close':
    case 'archive':
      plan.closed = true;
      plan.expanded = false;
      break;
    case 'update':
    default:
      if ('mode' in input) plan.mode = normalizeMode(input.mode);
      if ('intent' in input) { plan.intent = cleanText(input.intent); contentChanged = true; }
      if ('proposal' in input || 'plan' in input) {
        plan.proposal = cleanText(input.proposal ?? input.plan);
        contentChanged = true;
      }
      if ('todos' in input) { plan.todos = normalizeTodos(input.todos); contentChanged = true; }
      if ('notes' in input) { plan.notes = cleanText(input.notes); contentChanged = true; }
      if ('approval' in input) plan.approval = normalizeApproval(input.approval, plan.mode);
      if ('expanded' in input) plan.expanded = input.expanded !== false;
      break;
  }

  plan.nextTodoId = Math.max(plan.nextTodoId ?? 1, nextTodoSequence(plan.todos));
  plan.cursor = clamp(finiteInt(plan.cursor, 0), 0, Math.max(0, plan.todos.length - 1));
  const fullyCompleted = plan.todos.length > 0
    && plan.todos.every((todo) => todo.status === 'completed');
  if (fullyCompleted) plan.completedAt ||= Date.now();
  else if (contentChanged) {
    plan.completedAt = 0;
    plan.closed = false;
  }
  if (contentChanged && !('approval' in input) && plan.mode === 'plan'
    && !['approval', 'set_approval'].includes(action)) plan.approval = 'pending';
  touchPlan(plan, input.source ?? 'tool');
  return plan;
}

/** Per-user-turn instruction injected by the Pi before_agent_start extension. */
export function buildPlanTurnInjection(value) {
  const plan = serializePlanState(value);
  const progress = planProgress(plan);
  if (plan.mode === 'go') {
    const live = plan.todos.length && !plan.closed
      ? `Active execution plan (${progress.done}/${progress.total}):\n${formatTodos(plan.todos)}`
      : plan.completedAt ? 'The previous execution plan is complete; there is no active plan.'
        : 'There is no active execution plan.';
    return [
      '[APPROX MODE: GO]',
      'Execute the user intent directly and keep visible progress truthful. For a large, ambiguous, multi-system, or high-consequence request, call set_mode with mode="plan" before making changes. Do not merely announce a plan-mode switch.',
      'When an active plan exists, use update_plan as work advances: mark only actually finished items completed, keep one current item in_progress, revise stale steps, and preserve hidden notes that still matter.',
      live,
    ].join('\n');
  }

  const intent = plan.intent || 'Infer the user intent from the latest request and confirm the important unknowns.';
  const proposal = plan.proposal || 'No proposal has been published yet. Explore the design space, then call update_plan with a concrete proposal and Todo list.';
  const notes = plan.notes ? clip(plan.notes, 500) : '(none yet)';
  return [
    '[APPROX MODE: PLAN]',
    'Stay in analysis and design. Examine the user\'s underlying intent, constraints, failure modes, alternative implementations, and at least one non-obvious opportunity. Prefer a sharp, creative execution design over a generic checklist.',
    'Use ask_questions for material unknowns (up to five structured single/multi/text questions). Use update_plan to publish and continuously maintain the visible Todo list and the hidden Notes-to-self. Do not perform implementation mutations before explicit user approval. After approval, call set_mode with mode="go" and execute the approved plan to completion.',
    `Approval: ${plan.approval}. Intent: ${clip(intent, 420)}`,
    `Proposal: ${clip(proposal, 700)}`,
    `Todo (${progress.done}/${progress.total}):\n${formatTodos(plan.todos)}`,
    `Hidden notes: ${notes}`,
  ].join('\n');
}

export function planProgress(value) {
  const todos = normalizeTodos(value?.todos);
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const active = todos.findIndex((todo) => todo.status === 'in_progress');
  return { done, total: todos.length, active, ratio: todos.length ? done / todos.length : 0 };
}

export const planMethods = {
  ensurePlanState() {
    if (!this.st.plan?.anim) this.st.plan = hydratePlanState(this.st.plan ?? {});
    return this.st.plan;
  },

  setMode(mode, options = {}) { return this.setPlanMode(mode, options); },

  setPlanMode(mode, { source = 'user', reason = '', notifyBackend = true, silent = false } = {}) {
    const plan = this.ensurePlanState();
    const next = normalizeMode(mode);
    if (plan.mode === next) return serializePlanState(plan);
    applyPlanOperation(plan, { action: 'mode', mode: next, source });
    plan.anim.set(planShouldShow(plan) ? 1 : 0, !!this.st.reduceMotion);
    if (next === 'plan') plan.expanded = true;
    this.s?.invalidate?.();
    if (!silent) this.toast?.(`${next === 'plan' ? 'Plan' : 'Go'} mode${reason ? ` · ${reason}` : ''}`, 'ok');
    if (notifyBackend && this.backend?.setMode) {
      void Promise.resolve(this.backend.setMode(next, { source, reason })).catch((error) => {
        this.toast?.(String(error?.message ?? error), 'warn');
      });
    }
    return serializePlanState(plan);
  },

  cycleMode() {
    const plan = this.ensurePlanState();
    return this.setPlanMode(plan.mode === 'plan' ? 'go' : 'plan');
  },

  commandMode(value = '') {
    const mode = String(value ?? '').trim().toLowerCase();
    if (!mode) return this.cycleMode();
    if (!PLAN_MODES.includes(mode)) return this.toast?.('choose Go or Plan mode', 'warn');
    return this.setPlanMode(mode);
  },

  applyPlanState(snapshot, { pulse = true } = {}) {
    const current = this.ensurePlanState();
    this.st.plan = hydratePlanState(snapshot, current);
    if (pulse) pulsePlan(this.st.plan);
    this.armPlanCompletion();
    this.s?.invalidate?.();
    return serializePlanState(this.st.plan);
  },

  updatePlan(input = {}, { notifyBackend = false } = {}) {
    const plan = this.ensurePlanState();
    applyPlanOperation(plan, input);
    plan.cursorAnim.set(plan.cursor, !!this.st.reduceMotion);
    plan.anim.set(planShouldShow(plan) ? 1 : 0, !!this.st.reduceMotion);
    pulsePlan(plan);
    this.armPlanCompletion();
    this.s?.invalidate?.();
    const snapshot = serializePlanState(plan);
    if (notifyBackend && this.backend?.updatePlan) {
      void Promise.resolve(this.backend.updatePlan(input)).catch((error) => this.toast?.(String(error?.message ?? error), 'warn'));
    }
    return snapshot;
  },

  armPlanCompletion() {
    const plan = this.ensurePlanState();
    const complete = plan.todos.length > 0
      && plan.todos.every((todo) => todo.status === 'completed');
    if (!complete || plan.closed) {
      this._planFinishToken = '';
      return false;
    }
    const token = `${plan.revision}:${plan.completedAt}`;
    if (this._planFinishToken === token) return true;
    this._planFinishToken = token;
    this.later?.(() => {
      const current = this.ensurePlanState();
      if (this._planFinishToken !== token || current.closed
        || !current.todos.length
        || current.todos.some((todo) => todo.status !== 'completed')) return;
      this.updatePlan({ action: 'close', source: 'system' }, { notifyBackend: true });
      this.toast?.('plan complete', 'ok');
    }, 1400);
    return true;
  },

  proposePlan(value = {}) {
    return this.updatePlan({ action: 'propose', ...value }, { notifyBackend: true });
  },

  addPlanTodo(text, options = {}) {
    return this.updatePlan({ action: 'add_todo', text, ...options }, { notifyBackend: true });
  },

  editPlanTodo(id, patch = {}) {
    return this.updatePlan({ action: 'update_todo', id, ...patch }, { notifyBackend: true });
  },

  completePlanTodo(id, completed = true) {
    return this.updatePlan({ action: 'complete_todo', id, completed }, { notifyBackend: true });
  },

  togglePlanTodo(id) {
    return this.updatePlan({ action: 'toggle_todo', id }, { notifyBackend: true });
  },

  removePlanTodo(id) {
    return this.updatePlan({ action: 'remove_todo', id }, { notifyBackend: true });
  },

  movePlanTodo(id, offset) {
    return this.updatePlan({ action: 'move_todo', id, offset }, { notifyBackend: true });
  },

  editPlanOverview() {
    const plan = this.ensurePlanState();
    return this.openQuestionnaire({
      id: `plan-overview-${Date.now().toString(36)}`,
      title: 'EDIT PLAN',
      intro: 'Refine what the plan delivers and how it will get there.',
      questions: [
        {
          id: 'intent',
          type: 'text',
          prompt: 'Plan summary',
          placeholder: 'What outcome should this plan deliver?',
          defaultValue: plan.intent,
          required: false,
          maxLength: 2_000,
        },
        {
          id: 'proposal',
          type: 'text',
          prompt: 'Approach',
          placeholder: 'Describe the execution approach and key decisions.',
          defaultValue: plan.proposal,
          required: false,
          maxLength: 12_000,
        },
      ],
    }).then((result) => {
      if (result.cancelled) return false;
      this.updatePlan({
        action: 'update',
        intent: result.values.intent,
        proposal: result.values.proposal,
        source: 'user',
      }, { notifyBackend: true });
      this.toast?.('plan updated', 'ok');
      return true;
    }).catch((error) => {
      this.toast?.(String(error?.message ?? error), 'warn');
      return false;
    });
  },

  addPlanTodoFromEditor() {
    return this.openPlanTodoEditor({ mode: 'add' });
  },

  editSelectedPlanTodo() {
    const plan = this.ensurePlanState();
    const todo = plan.todos[plan.cursor];
    if (!todo) {
      this.toast?.('add a Todo first', 'info');
      return false;
    }
    return this.openPlanTodoEditor({ mode: 'edit', todo });
  },

  openPlanTodoEditor({ mode = 'add', todo = null } = {}) {
    const editing = mode === 'edit' && todo;
    return this.openQuestionnaire({
      id: `plan-todo-${Date.now().toString(36)}`,
      title: editing ? 'EDIT TODO' : 'ADD TODO',
      intro: editing ? 'Keep this step concrete and verifiable.' : 'Add one concrete step to the active plan.',
      questions: [
        {
          id: 'todo-text',
          type: 'text',
          prompt: editing ? 'Todo text' : 'New Todo',
          placeholder: 'Describe one concrete, verifiable task.',
          defaultValue: editing ? todo.text : '',
          required: true,
          maxLength: 2_000,
        },
        {
          id: 'todo-note',
          type: 'text',
          prompt: 'Note / comment (optional)',
          placeholder: 'Add constraints, context, or a verification detail.',
          defaultValue: editing ? todo.note : '',
          required: false,
          maxLength: MAX_TODO_NOTE,
        },
      ],
    }).then((result) => {
      if (result.cancelled) return false;
      const text = result.values['todo-text'];
      const note = result.values['todo-note'];
      if (editing) this.editPlanTodo(todo.id, { text, note, source: 'user' });
      else this.addPlanTodo(text, { note, source: 'user' });
      this.toast?.(editing ? 'Todo updated' : 'Todo added', 'ok');
      return true;
    }).catch((error) => {
      this.toast?.(String(error?.message ?? error), 'warn');
      return false;
    });
  },

  deleteSelectedPlanTodo() {
    const plan = this.ensurePlanState();
    const todo = plan.todos[plan.cursor];
    if (!todo) {
      this.toast?.('no Todo selected', 'info');
      return false;
    }
    this.removePlanTodo(todo.id);
    this.toast?.('Todo removed', 'info');
    return true;
  },

  moveSelectedPlanTodo(offset) {
    const plan = this.ensurePlanState();
    const todo = plan.todos[plan.cursor];
    const to = clamp(plan.cursor + finiteInt(offset, 0), 0, Math.max(0, plan.todos.length - 1));
    if (!todo || to === plan.cursor) return false;
    this.movePlanTodo(todo.id, to - plan.cursor);
    return true;
  },

  setPlanNotes(notes) {
    return this.updatePlan({ action: 'set_notes', notes }, { notifyBackend: true });
  },

  setPlanExpanded(expanded) {
    const plan = this.ensurePlanState();
    plan.expanded = !!expanded;
    touchPlan(plan, 'user');
    pulsePlan(plan);
    this.s?.invalidate?.();
    return plan.expanded;
  },

  togglePlanExpanded() {
    return this.setPlanExpanded(!this.ensurePlanState().expanded);
  },

  requestPlanApproval() {
    return this.updatePlan({ action: 'set_approval', approval: 'pending', source: 'user' }, { notifyBackend: true });
  },

  approvePlan({ source = 'user' } = {}) {
    const plan = this.ensurePlanState();
    applyPlanOperation(plan, { action: 'set_approval', approval: 'approved', source });
    const snapshot = serializePlanState(plan);
    if (this.backend?.approvePlan) {
      void Promise.resolve(this.backend.approvePlan(snapshot)).catch((error) => this.toast?.(String(error?.message ?? error), 'warn'));
    }
    this.setPlanMode('go', { source, reason: 'approved', notifyBackend: true, silent: true });
    this.toast?.('plan approved · Go mode', 'ok');
    pulsePlan(plan);
    return serializePlanState(plan);
  },

  rejectPlan({ source = 'user' } = {}) {
    const plan = this.ensurePlanState();
    return this.openQuestionnaire({
      id: `plan-revision-${Date.now().toString(36)}`,
      title: 'REVISE PLAN',
      intro: 'Tell Pi what should change before it publishes the next proposal.',
      questions: [{
        id: 'feedback',
        type: 'text',
        prompt: 'Revision feedback',
        placeholder: 'What should Pi change, preserve, remove, or investigate?',
        required: true,
        maxLength: 4_000,
      }],
    }).then(async (result) => {
      if (result.cancelled) return false;
      const feedback = String(result.values.feedback ?? '').trim();
      applyPlanOperation(plan, { action: 'set_approval', approval: 'rejected', source });
      applyPlanOperation(plan, { action: 'mode', mode: 'plan', source });
      pulsePlan(plan);
      this.s?.invalidate?.();
      const snapshot = serializePlanState(plan);
      if (this.backend?.rejectPlan) await this.backend.rejectPlan(snapshot, feedback);
      else if (this.backend?.updatePlan) {
        await this.backend.updatePlan({ action: 'set_approval', approval: 'rejected', source });
      }
      this.toast?.('revision requested · Pi is re-planning', 'info');
      return snapshot;
    }).catch((error) => {
      const current = this.ensurePlanState();
      if (current.approval === 'rejected') {
        applyPlanOperation(current, { action: 'set_approval', approval: 'pending', source: 'system' });
        pulsePlan(current);
        this.s?.invalidate?.();
      }
      this.toast?.(String(error?.message ?? error), 'warn');
      return false;
    });
  },

  focusPlan() {
    const plan = this.ensurePlanState();
    plan.focused = true;
    plan.expanded = true;
    plan.cursor = clamp(plan.cursor, 0, Math.max(0, plan.todos.length - 1));
    plan.cursorAnim.set(plan.cursor, true);
    pulsePlan(plan);
    return true;
  },

  blurPlan() {
    const plan = this.ensurePlanState();
    plan.focused = false;
    plan.drag = null;
    this.s?.invalidate?.();
  },

  planKey(k) {
    const plan = this.ensurePlanState();
    if (!plan.focused) return false;
    const key = String(k.name ?? '').toLowerCase();
    if (k.name === 'escape') { this.blurPlan(); return true; }
    if (k.name === 'left') { this.setPlanExpanded(false); return true; }
    if (k.name === 'right') { this.setPlanExpanded(true); return true; }
    if (k.name === 'tab') { this.togglePlanExpanded(); return true; }
    if (k.name === 'up' || k.name === 'down') {
      if (k.shift) {
        this.moveSelectedPlanTodo(k.name === 'down' ? 1 : -1);
        return true;
      }
      const n = plan.todos.length;
      if (n) plan.cursor = (plan.cursor + (k.name === 'down' ? 1 : -1) + n) % n;
      plan.cursorAnim.set(plan.cursor, !!this.st.reduceMotion);
      this.s?.invalidate?.();
      return true;
    }
    if ((key === 'y' || k.name === 'enter') && plan.approval === 'pending') {
      this.approvePlan();
      return true;
    }
    if (key === 'n' && plan.approval === 'pending') { this.rejectPlan(); return true; }
    if (key === 'a') { void this.addPlanTodoFromEditor(); return true; }
    if (key === 'e') { void this.editSelectedPlanTodo(); return true; }
    if (key === 'd' || k.name === 'delete') { this.deleteSelectedPlanTodo(); return true; }
    if (key === 'p') { void this.editPlanOverview(); return true; }
    if ((k.name === 'space' || k.name === 'enter') && plan.todos[plan.cursor]) {
      this.togglePlanTodo(plan.todos[plan.cursor].id);
      return true;
    }
    return true;
  },

  planPointerDown(x, y) {
    const plan = this.ensurePlanState();
    if (!pointInPlan(plan, x, y)) return this.planPointer(x, y, true);
    const hit = planHitAt(plan, x, y);
    if (hit?.kind === 'todo') {
      const index = findTodoIndex(plan, hit.id);
      if (index >= 0) {
        plan.focused = true;
        plan.cursor = index;
        plan.cursorAnim.set(index, !!this.st.reduceMotion);
        plan.drag = { id: hit.id, start: index, last: index, moved: false };
        this.s?.invalidate?.();
        return true;
      }
    }
    plan.drag = null;
    return this.planPointer(x, y, true);
  },

  planPointerDrag(_x, y) {
    const plan = this.ensurePlanState();
    const drag = plan.drag;
    if (!drag) return false;
    const hit = [...(plan.hits ?? [])].reverse().find((item) =>
      item.kind === 'todo' && y === item.y);
    if (!hit) return true;
    const from = findTodoIndex(plan, drag.id);
    const to = clamp(Number.isInteger(hit.index) ? hit.index : findTodoIndex(plan, hit.id),
      0, Math.max(0, plan.todos.length - 1));
    if (from < 0 || to === from) return true;
    drag.moved = true;
    drag.last = to;
    this.updatePlan({ action: 'move_todo', id: drag.id, to, source: 'user' }, { notifyBackend: true });
    this.ensurePlanState().drag = drag;
    return true;
  },

  planPointerUp(x, y) {
    const plan = this.ensurePlanState();
    const drag = plan.drag;
    if (!drag) return false;
    plan.drag = null;
    if (!drag.moved) {
      const hit = planHitAt(plan, x, y);
      if (hit?.kind === 'todo' && hit.id === drag.id) this.togglePlanTodo(drag.id);
    }
    this.s?.invalidate?.();
    return true;
  },

  planPointer(x, y, activate = true) {
    const plan = this.ensurePlanState();
    if (!pointInPlan(plan, x, y)) {
      if (activate && plan.focused) this.blurPlan();
      return false;
    }
    const hit = planHitAt(plan, x, y);
    if (hit?.kind === 'todo') {
      const index = findTodoIndex(plan, hit.id);
      if (index >= 0) {
        plan.cursor = index;
        plan.cursorAnim.set(index, !!this.st.reduceMotion);
      }
    }
    if (!activate) return true;
    plan.focused = true;
    if (hit?.kind === 'header' || hit?.kind === 'collapse') this.togglePlanExpanded();
    else if (hit?.kind === 'summary') void this.editPlanOverview();
    else if (hit?.kind === 'add') void this.addPlanTodoFromEditor();
    else if (hit?.kind === 'edit') void this.editSelectedPlanTodo();
    else if (hit?.kind === 'delete') this.deleteSelectedPlanTodo();
    else if (hit?.kind === 'todo') this.togglePlanTodo(hit.id);
    else if (hit?.kind === 'approve') this.approvePlan();
    else if (hit?.kind === 'reject') this.rejectPlan();
    return true;
  },

  stepPlanAnimations(dt) {
    const plan = this.ensurePlanState();
    plan.anim.step(dt);
    plan.pulse.step(dt);
    plan.cursorAnim.step(dt);
  },

  planTurnInjection() {
    return buildPlanTurnInjection(this.ensurePlanState());
  },
};

function normalizeMode(value) {
  return String(value ?? '').toLowerCase() === 'plan' ? 'plan' : 'go';
}

function normalizeApproval(value, mode = 'go') {
  const approval = String(value ?? '').toLowerCase();
  if (PLAN_APPROVALS.includes(approval)) return approval;
  return mode === 'plan' ? 'draft' : 'none';
}

function normalizeTodoStatus(value) {
  const status = String(value ?? '').toLowerCase().replace(/[- ]/g, '_');
  if (status === 'done' || status === 'complete') return 'completed';
  if (status === 'active' || status === 'doing') return 'in_progress';
  return TODO_STATES.includes(status) ? status : 'pending';
}

function normalizeTodos(value) {
  if (!Array.isArray(value)) return [];
  const used = new Set();
  const todos = [];
  for (let i = 0; i < value.length && todos.length < MAX_TODOS; i++) {
    const raw = typeof value[i] === 'string' ? { text: value[i] } : (value[i] ?? {});
    const text = cleanText(raw.text ?? raw.title ?? raw.label, 2_000);
    if (!text) continue;
    let id = cleanText(raw.id, 120) || `todo-${i + 1}`;
    if (used.has(id)) id = `${id}-${i + 1}`;
    used.add(id);
    const note = cleanText(raw.note ?? raw.comment, MAX_TODO_NOTE);
    const status = raw.done === true ? 'completed' : normalizeTodoStatus(raw.status);
    todos.push({ id, text, note, status });
  }
  return todos;
}

function nextTodoSequence(todos) {
  let next = 1;
  for (const todo of todos ?? []) {
    const match = /(?:^|-)todo-(\d+)$/.exec(String(todo.id));
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

function uniqueTodoId(plan, wanted) {
  const used = new Set(plan.todos.map((todo) => todo.id));
  let id = cleanText(wanted, 120);
  if (id && !used.has(id)) return id;
  do id = `todo-${plan.nextTodoId++}`; while (used.has(id));
  return id;
}

function findTodoIndex(plan, idOrIndex) {
  if (Number.isInteger(idOrIndex)) return idOrIndex >= 0 && idOrIndex < plan.todos.length ? idOrIndex : -1;
  return plan.todos.findIndex((todo) => todo.id === String(idOrIndex ?? ''));
}

function findTodo(plan, idOrIndex) {
  const index = findTodoIndex(plan, idOrIndex);
  return index >= 0 ? plan.todos[index] : null;
}

function pointInPlan(plan, x, y) {
  const g = plan?.geometry;
  return !!g && x >= g.x && x < g.x + g.w && y >= g.y && y < g.y + g.h;
}

function planHitAt(plan, x, y) {
  return [...(plan?.hits ?? [])].reverse().find((item) =>
    y === item.y && x >= item.x1 && x <= item.x2) ?? null;
}

function touchPlan(plan, source = 'local') {
  plan.revision = finiteInt(plan.revision, 0) + 1;
  plan.updatedAt = Date.now();
  plan.source = cleanText(source, 80) || 'local';
}

function pulsePlan(plan) {
  plan.pulse?.set(1, true);
  plan.pulse?.set(0);
}

function formatTodos(todos) {
  if (!todos.length) return '- [ ] Publish the execution plan with update_plan.';
  const visible = todos.slice(0, 16).map((todo) => {
    const mark = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '>' : ' ';
    const note = todo.note ? `\n  note: ${clip(todo.note, 300).replace(/\s+/g, ' ')}` : '';
    return `- [${mark}] ${todo.id}: ${clip(todo.text, 180)}${note}`;
  });
  if (todos.length > visible.length) visible.push(`- ... ${todos.length - visible.length} more`);
  return visible.join('\n');
}

function clip(value, max) {
  const text = cleanText(value, max + 1);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}
