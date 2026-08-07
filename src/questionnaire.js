import { Spring, clamp } from './anim.js';
import { cleanText, finiteInt } from './value-utils.js';

export const QUESTION_TYPES = ['single', 'multi', 'text'];
export const MAX_QUESTIONS = 5;
export const MAX_CHOICES = 16;
export const OTHER_OPTION_VALUE = '__something_else__';

export function createQuestionnaireState(seed = {}) {
  const request = normalizeQuestionnaireRequest(seed);
  const answers = initialAnswers(request.questions, seed.answers);
  const state = {
    open: !!seed.open && request.questions.length > 0,
    closing: false,
    requestId: request.id,
    title: request.title,
    intro: request.intro,
    questions: request.questions,
    answers,
    otherAnswers: { ...(seed.otherAnswers ?? {}) },
    otherEditing: false,
    otherQuestionId: null,
    index: clamp(finiteInt(seed.index, 0), 0, Math.max(0, request.questions.length - 1)),
    choiceCursor: 0,
    textCursor: 0,
    choiceScroll: 0,
    direction: 1,
    validation: '',
    hits: [],
    geometry: null,
    result: null,
    anim: new Spring(seed.open ? 1 : 0, { stiff: 20, damp: 0.84 }),
    stepAnim: new Spring(1, { stiff: 24, damp: 0.82 }),
    cursorAnim: new Spring(0, { stiff: 25, damp: 0.9 }),
    shake: new Spring(0, { stiff: 34, damp: 0.64 }),
    pulse: new Spring(0, { stiff: 18, damp: 0.76 }),
  };
  syncQuestionCursor(state);
  syncOtherEditor(state);
  return state;
}

export function normalizeQuestionnaireRequest(value = {}) {
  const rawQuestions = Array.isArray(value) ? value : value.questions;
  const questions = [];
  const ids = new Set();
  for (let i = 0; i < (rawQuestions?.length ?? 0) && questions.length < MAX_QUESTIONS; i++) {
    const raw = typeof rawQuestions[i] === 'string' ? { prompt: rawQuestions[i], type: 'text' } : (rawQuestions[i] ?? {});
    const prompt = cleanText(raw.prompt ?? raw.question ?? raw.label, 2_000);
    if (!prompt) continue;
    let id = cleanId(raw.id) || `question-${i + 1}`;
    if (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    const rawType = String(raw.type ?? '').toLowerCase();
    const type = normalizeQuestionType(raw.type);
    const options = type === 'text' ? [] : normalizeChoices(raw.options ?? raw.choices);
    // A malformed choice question remains answerable instead of trapping the UI.
    const resolvedType = type !== 'text' && options.every((option) => option.other) ? 'text' : type;
    questions.push({
      id,
      type: resolvedType,
      secret: type === 'text' && ['secret', 'password', 'api_key'].includes(rawType),
      prompt,
      description: cleanText(raw.description ?? raw.hint, 1_000),
      placeholder: cleanText(raw.placeholder, 300),
      required: raw.required !== false,
      options: resolvedType === 'text' ? [] : options,
      defaultValue: normalizeDefault(raw.defaultValue ?? raw.default ?? raw.value, resolvedType, options),
      minSelections: clamp(finiteInt(raw.minSelections, raw.required === false ? 0 : 1), 0, options.length),
      maxSelections: clamp(finiteInt(raw.maxSelections, options.length), 1, Math.max(1, options.length)),
      maxLength: clamp(finiteInt(raw.maxLength, 4_000), 1, 12_000),
    });
  }
  return {
    id: cleanId(value.id ?? value.requestId) || `questions-${Date.now().toString(36)}`,
    title: cleanText(value.title, 200) || 'A FEW SHARP QUESTIONS',
    intro: cleanText(value.intro ?? value.description, 1_000),
    questions,
  };
}

/** JSON-safe payload returned to the waiting backend tool. */
export function questionnaireResult(state, cancelled = false, reason = '') {
  const answers = state.questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    type: question.type,
    value: questionnaireAnswerValue(state, question),
  }));
  return {
    requestId: state.requestId,
    cancelled: !!cancelled,
    ...(reason ? { reason: cleanText(reason, 300) } : {}),
    answers,
    values: Object.fromEntries(answers.map((answer) => [answer.id, answer.value])),
  };
}

export const questionnaireMethods = {
  ensureQuestionnaireState() {
    if (!this.st.questionnaire?.anim) this.st.questionnaire = createQuestionnaireState(this.st.questionnaire ?? {});
    return this.st.questionnaire;
  },

  isQuestionnaireOpen() {
    return !!this.st.questionnaire?.open;
  },

  /** Open one wizard of up to five questions and resolve when it is submitted/cancelled. */
  openQuestionnaire(request, { signal } = {}) {
    if (this.st.questionnaire?.open) this.cancelQuestionnaire('superseded');
    const next = createQuestionnaireState(Array.isArray(request)
      ? { questions: request, open: true }
      : { ...request, open: true });
    if (!next.questions.length) {
      return Promise.resolve(questionnaireResult(next, true, 'No valid questions were supplied'));
    }
    this.st.questionnaire = next;
    next.anim.set(1);
    next.stepAnim.set(1, true);
    next.pulse.set(1, true);
    next.pulse.set(0);
    this.s?.invalidate?.();

    return new Promise((resolve) => {
      this._questionnaireResolver = resolve;
      this._questionnaireAbortCleanup?.();
      this._questionnaireAbortCleanup = null;
      if (!signal) return;
      const abort = () => this.cancelQuestionnaire('interrupted');
      if (signal.aborted) abort();
      else {
        signal.addEventListener('abort', abort, { once: true });
        this._questionnaireAbortCleanup = () => signal.removeEventListener('abort', abort);
      }
    });
  },

  requestQuestionnaire(request, options) { return this.openQuestionnaire(request, options); },

  currentQuestion() {
    const state = this.ensureQuestionnaireState();
    return state.questions[state.index] ?? null;
  },

  setQuestionnaireIndex(index) {
    const state = this.ensureQuestionnaireState();
    if (!state.questions.length) return false;
    const next = clamp(index, 0, state.questions.length - 1);
    if (next === state.index) return true;
    state.direction = next > state.index ? 1 : -1;
    state.index = next;
    state.validation = '';
    state.choiceScroll = 0;
    state.stepAnim.set(0, true);
    state.stepAnim.set(1);
    syncQuestionCursor(state);
    syncOtherEditor(state);
    this.s?.invalidate?.();
    return true;
  },

  questionnaireBack() {
    const state = this.ensureQuestionnaireState();
    if (state.index > 0) return this.setQuestionnaireIndex(state.index - 1);
    return true;
  },

  questionnaireNext() {
    const state = this.ensureQuestionnaireState();
    const question = state.questions[state.index];
    if (!validateAnswer(state, question)) return this.questionnaireValidationError(question);
    if (state.index < state.questions.length - 1) return this.setQuestionnaireIndex(state.index + 1);
    return this.finishQuestionnaire(false);
  },

  questionnaireValidationError(question = this.currentQuestion()) {
    const state = this.ensureQuestionnaireState();
    state.validation = validationMessage(state, question);
    state.shake.set(state.direction || 1, true);
    state.shake.set(0);
    state.pulse.set(1, true);
    state.pulse.set(0);
    this.toast?.(state.validation, 'warn');
    this.s?.invalidate?.();
    return false;
  },

  setQuestionnaireAnswer(id, value) {
    const state = this.ensureQuestionnaireState();
    const question = state.questions.find((item) => item.id === id);
    if (!question) return false;
    state.answers[id] = normalizeAnswer(value, question);
    if (question.type === 'text') state.textCursor = [...state.answers[id]].length;
    state.validation = '';
    state.pulse.set(1, true);
    state.pulse.set(0);
    this.s?.invalidate?.();
    return true;
  },

  chooseQuestionnaireOption(index, { advance = false } = {}) {
    const state = this.ensureQuestionnaireState();
    const question = state.questions[state.index];
    const option = question?.options[index];
    if (!question || !option || question.type === 'text') return false;
    state.choiceCursor = index;
    state.cursorAnim.set(index, !!this.st.reduceMotion);
    if (option.value === OTHER_OPTION_VALUE) {
      if (question.type === 'single') state.answers[question.id] = option.value;
      else {
        const selected = new Set(Array.isArray(state.answers[question.id]) ? state.answers[question.id] : []);
        if (!selected.has(option.value) && selected.size >= question.maxSelections) {
          state.validation = `Choose no more than ${question.maxSelections}`;
          pulseQuestionnaire(state);
          this.s?.invalidate?.();
          return false;
        }
        selected.add(option.value);
        state.answers[question.id] = question.options.map((item) => item.value)
          .filter((value) => selected.has(value));
      }
      state.otherQuestionId = question.id;
      state.otherEditing = true;
      state.textCursor = [...String(state.otherAnswers[question.id] ?? '')].length;
      state.validation = '';
      pulseQuestionnaire(state);
      this.s?.invalidate?.();
      // Selecting the escape hatch enters its text field; it should not advance
      // before the user has had a chance to provide the custom answer.
      return true;
    }
    if (state.otherQuestionId === question.id) {
      state.otherQuestionId = null;
      state.otherEditing = false;
    }
    if (question.type === 'single') {
      state.answers[question.id] = option.value;
      state.validation = '';
      pulseQuestionnaire(state);
      if (advance) return this.questionnaireNext();
      return true;
    }
    const selected = new Set(Array.isArray(state.answers[question.id]) ? state.answers[question.id] : []);
    if (selected.has(option.value)) selected.delete(option.value);
    else if (selected.size < question.maxSelections) selected.add(option.value);
    state.answers[question.id] = question.options.map((item) => item.value).filter((value) => selected.has(value));
    state.validation = '';
    pulseQuestionnaire(state);
    return true;
  },

  insertQuestionnaireText(value) {
    const state = this.ensureQuestionnaireState();
    const question = state.questions[state.index];
    if (question?.type !== 'text') return false;
    const chars = [...String(state.answers[question.id] ?? '')];
    const insert = [...String(value ?? '')];
    const room = Math.max(0, question.maxLength - chars.length);
    chars.splice(state.textCursor, 0, ...insert.slice(0, room));
    state.textCursor = Math.min(question.maxLength, state.textCursor + Math.min(room, insert.length));
    state.answers[question.id] = chars.join('');
    state.validation = '';
    this.s?.invalidate?.();
    return true;
  },

  deleteQuestionnaireText(forward = false) {
    const state = this.ensureQuestionnaireState();
    const question = state.questions[state.index];
    if (question?.type !== 'text') return false;
    const chars = [...String(state.answers[question.id] ?? '')];
    const index = forward ? state.textCursor : state.textCursor - 1;
    if (index < 0 || index >= chars.length) return true;
    chars.splice(index, 1);
    if (!forward) state.textCursor--;
    state.answers[question.id] = chars.join('');
    state.validation = '';
    this.s?.invalidate?.();
    return true;
  },

  moveQuestionnaireTextCursor(delta, edge = null) {
    const state = this.ensureQuestionnaireState();
    const question = state.questions[state.index];
    if (question?.type !== 'text') return false;
    const length = [...String(state.answers[question.id] ?? '')].length;
    state.textCursor = edge === 'start' ? 0 : edge === 'end' ? length : clamp(state.textCursor + delta, 0, length);
    this.s?.invalidate?.();
    return true;
  },

  insertQuestionnaireOtherText(value) {
    const state = this.ensureQuestionnaireState();
    const question = state.questions[state.index];
    if (!question || !state.otherEditing || state.otherQuestionId !== question.id) return false;
    const chars = [...String(state.otherAnswers[question.id] ?? '')];
    const insert = [...String(value ?? '')];
    const room = Math.max(0, question.maxLength - chars.length);
    chars.splice(state.textCursor, 0, ...insert.slice(0, room));
    state.textCursor = Math.min(question.maxLength, state.textCursor + Math.min(room, insert.length));
    state.otherAnswers[question.id] = chars.join('');
    state.validation = '';
    this.s?.invalidate?.();
    return true;
  },

  deleteQuestionnaireOtherText(forward = false) {
    const state = this.ensureQuestionnaireState();
    const question = state.questions[state.index];
    if (!question || !state.otherEditing || state.otherQuestionId !== question.id) return false;
    const chars = [...String(state.otherAnswers[question.id] ?? '')];
    const index = forward ? state.textCursor : state.textCursor - 1;
    if (index < 0 || index >= chars.length) return true;
    chars.splice(index, 1);
    if (!forward) state.textCursor--;
    state.otherAnswers[question.id] = chars.join('');
    state.validation = '';
    this.s?.invalidate?.();
    return true;
  },

  moveQuestionnaireOtherCursor(delta, edge = null) {
    const state = this.ensureQuestionnaireState();
    const question = state.questions[state.index];
    if (!question || !state.otherEditing || state.otherQuestionId !== question.id) return false;
    const length = [...String(state.otherAnswers[question.id] ?? '')].length;
    state.textCursor = edge === 'start' ? 0 : edge === 'end' ? length : clamp(state.textCursor + delta, 0, length);
    this.s?.invalidate?.();
    return true;
  },

  finishQuestionnaire(cancelled = false, reason = '') {
    const state = this.ensureQuestionnaireState();
    if (!state.open && state.result) return state.result;
    if (!cancelled) {
      const invalid = state.questions.findIndex((question) => !validateAnswer(state, question));
      if (invalid >= 0) {
        this.setQuestionnaireIndex(invalid);
        return this.questionnaireValidationError(state.questions[invalid]);
      }
    }
    const result = questionnaireResult(state, cancelled, reason);
    state.result = result;
    state.open = false;
    state.closing = true;
    state.anim.set(0, !!this.st.reduceMotion);
    this._questionnaireAbortCleanup?.();
    this._questionnaireAbortCleanup = null;
    const resolve = this._questionnaireResolver;
    this._questionnaireResolver = null;
    try { resolve?.(result); } catch { /* Consumer errors do not break the TUI. */ }
    if (this.backend?.resolveQuestionnaire) {
      void Promise.resolve(this.backend.resolveQuestionnaire(result.requestId, result)).catch((error) => {
        this.toast?.(String(error?.message ?? error), 'warn');
      });
    }
    this.s?.invalidate?.();
    return result;
  },

  answerQuestionnaire() { return this.finishQuestionnaire(false); },
  cancelQuestionnaire(reason = 'cancelled') { return this.finishQuestionnaire(true, reason); },

  questionnaireKey(k) {
    const state = this.ensureQuestionnaireState();
    if (!state.open) return false;
    const question = state.questions[state.index];
    if (!question) return true;
    if (k.name === 'escape') { this.cancelQuestionnaire('cancelled by user'); return true; }
    if (k.name === 'tab') { this.questionnaireNext(); return true; }
    if (k.name === 'enter') {
      if (question.type === 'text' && (k.shift || k.alt)) this.insertQuestionnaireText('\n');
      else if (state.otherEditing && state.otherQuestionId === question.id) this.questionnaireNext();
      else if (question.type === 'single') this.chooseQuestionnaireOption(state.choiceCursor, { advance: true });
      else this.questionnaireNext();
      return true;
    }
    if (k.name === 'up' || k.name === 'down') {
      if (question.type !== 'text' && question.options.length) {
        if (state.otherEditing && state.otherQuestionId === question.id) {
          state.otherEditing = false;
          state.otherQuestionId = null;
        }
        const d = k.name === 'down' ? 1 : -1;
        state.choiceCursor = (state.choiceCursor + d + question.options.length) % question.options.length;
        if (question.type === 'single') this.chooseQuestionnaireOption(state.choiceCursor);
        else state.cursorAnim.set(state.choiceCursor, !!this.st.reduceMotion);
        keepChoiceVisible(state);
        this.s?.invalidate?.();
      }
      return true;
    }
    if (k.name === 'left') {
      if (state.otherEditing && state.otherQuestionId === question.id) this.moveQuestionnaireOtherCursor(-1);
      else if (question.type === 'text') this.moveQuestionnaireTextCursor(-1);
      else this.questionnaireBack();
      return true;
    }
    if (k.name === 'right') {
      if (state.otherEditing && state.otherQuestionId === question.id) this.moveQuestionnaireOtherCursor(1);
      else if (question.type === 'text') this.moveQuestionnaireTextCursor(1);
      else this.questionnaireNext();
      return true;
    }
    if (k.name === 'space') {
      if (state.otherEditing && state.otherQuestionId === question.id) this.insertQuestionnaireOtherText(' ');
      else if (question.type === 'text') this.insertQuestionnaireText(' ');
      else this.chooseQuestionnaireOption(state.choiceCursor);
      return true;
    }
    if (state.otherEditing && state.otherQuestionId === question.id) {
      if (k.name === 'backspace') { this.deleteQuestionnaireOtherText(false); return true; }
      if (k.name === 'delete') { this.deleteQuestionnaireOtherText(true); return true; }
      if (k.name === 'home') { this.moveQuestionnaireOtherCursor(0, 'start'); return true; }
      if (k.name === 'end') { this.moveQuestionnaireOtherCursor(0, 'end'); return true; }
      if (k.printable && !k.ctrl && !k.alt) { this.insertQuestionnaireOtherText(k.name); return true; }
    }
    if (question.type === 'text') {
      if (k.name === 'backspace') { this.deleteQuestionnaireText(false); return true; }
      if (k.name === 'delete') { this.deleteQuestionnaireText(true); return true; }
      if (k.name === 'home') { this.moveQuestionnaireTextCursor(0, 'start'); return true; }
      if (k.name === 'end') { this.moveQuestionnaireTextCursor(0, 'end'); return true; }
      if (k.ctrl && k.name === 'w') {
        deleteTextWord(state, question);
        this.s?.invalidate?.();
        return true;
      }
      if (k.printable && !k.ctrl && !k.alt) { this.insertQuestionnaireText(k.name); return true; }
    }
    return true;
  },

  questionnairePointer(x, y, activate = true) {
    const state = this.ensureQuestionnaireState();
    if (!state.open) return false;
    const hit = [...(state.hits ?? [])].reverse().find((item) =>
      y === item.y && x >= item.x1 && x <= item.x2);
    if (hit?.kind === 'choice') {
      state.choiceCursor = hit.index;
      state.cursorAnim.set(hit.index, !!this.st.reduceMotion);
      this.s?.invalidate?.();
    }
    if (!activate) return true;
    if (!hit) return true;
    if (hit.kind === 'choice') this.chooseQuestionnaireOption(hit.index);
    else if (hit.kind === 'back') this.questionnaireBack();
    else if (hit.kind === 'next') this.questionnaireNext();
    else if (hit.kind === 'cancel') this.cancelQuestionnaire('cancelled by user');
    else if (hit.kind === 'step') this.setQuestionnaireIndex(hit.index);
    else if (hit.kind === 'text') {
      // Clicking the text well focuses it; exact terminal-column cursor mapping is
      // deliberately left to arrows because wrapping and wide glyphs share cells.
      const question = state.questions[state.index];
      state.textCursor = [...String(state.answers[question.id] ?? '')].length;
    } else if (hit.kind === 'other-text') {
      const question = state.questions[state.index];
      state.otherEditing = true;
      state.otherQuestionId = question.id;
      state.textCursor = [...String(state.otherAnswers[question.id] ?? '')].length;
    }
    return true;
  },

  stepQuestionnaireAnimations(dt) {
    const state = this.ensureQuestionnaireState();
    state.anim.step(dt);
    state.stepAnim.step(dt);
    state.cursorAnim.step(dt);
    state.shake.step(dt);
    state.pulse.step(dt);
    if (state.closing && state.anim.settled && state.anim.v <= 0.001) {
      state.closing = false;
      state.hits = [];
      state.geometry = null;
    }
  },
};

function normalizeQuestionType(value) {
  const type = String(value ?? 'single').toLowerCase();
  if (['multi', 'multiple', 'checkbox', 'checkboxes'].includes(type)) return 'multi';
  if (['text', 'input', 'freeform', 'free_form', 'secret', 'password', 'api_key'].includes(type)) return 'text';
  return 'single';
}

function normalizeChoices(value) {
  if (!Array.isArray(value)) return [];
  const choices = [];
  const values = new Set();
  for (let i = 0; i < value.length && choices.length < MAX_CHOICES; i++) {
    const raw = typeof value[i] === 'string' || typeof value[i] === 'number'
      ? { label: String(value[i]), value: String(value[i]) } : (value[i] ?? {});
    const label = cleanText(raw.label ?? raw.title ?? raw.value, 500);
    if (!label) continue;
    let optionValue = cleanText(raw.value ?? label, 500);
    if (values.has(optionValue)) optionValue = `${optionValue}-${i + 1}`;
    values.add(optionValue);
    choices.push({ value: optionValue, label, description: cleanText(raw.description ?? raw.hint, 500) });
  }
  // Every choice question keeps one escape hatch for answers the model did not
  // predict. Reserve the last slot when a request already fills the cap.
  if (!choices.some((item) => item.value === OTHER_OPTION_VALUE)) {
    if (choices.length >= MAX_CHOICES) choices.pop();
    choices.push({
      value: OTHER_OPTION_VALUE,
      label: 'Something else',
      description: 'Type your own answer',
      other: true,
    });
  }
  return choices;
}

function normalizeDefault(value, type, options) {
  if (type === 'text') return cleanText(value, 12_000);
  const allowed = new Set(options.map((item) => item.value));
  if (type === 'multi') {
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    return values.map(String).filter((item) => allowed.has(item));
  }
  const single = value == null ? null : String(value);
  return allowed.has(single) ? single : null;
}

function initialAnswers(questions, provided = {}) {
  const answers = {};
  for (const question of questions) {
    const value = Object.prototype.hasOwnProperty.call(provided ?? {}, question.id)
      ? provided[question.id] : question.defaultValue;
    answers[question.id] = normalizeAnswer(value, question);
  }
  return answers;
}

function normalizeAnswer(value, question) {
  if (question.type === 'text') return String(value ?? '').slice(0, question.maxLength);
  const allowed = new Set(question.options.map((item) => item.value));
  if (question.type === 'multi') {
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    return [...new Set(values.map(String).filter((item) => allowed.has(item)))].slice(0, question.maxSelections);
  }
  const single = value == null ? null : String(value);
  return allowed.has(single) ? single : null;
}

function validateAnswer(state, question) {
  if (!question) return false;
  const value = state.answers[question.id];
  if (question.type === 'text') return !question.required || String(value ?? '').trim().length > 0;
  if (question.type === 'multi') {
    const count = Array.isArray(value) ? value.length : 0;
    if (count < question.minSelections || count > question.maxSelections) return false;
    return !value.includes(OTHER_OPTION_VALUE)
      || String(state.otherAnswers?.[question.id] ?? '').trim().length > 0;
  }
  if (!question.required) return true;
  if (value === OTHER_OPTION_VALUE) {
    return String(state.otherAnswers?.[question.id] ?? '').trim().length > 0;
  }
  return value != null;
}

function questionnaireAnswerValue(state, question) {
  const value = cloneAnswer(state.answers[question.id], question.type);
  if (question.type === 'single' && value === OTHER_OPTION_VALUE) {
    return String(state.otherAnswers?.[question.id] ?? '');
  }
  if (question.type === 'multi' && Array.isArray(value)) {
    return value.map((item) => item === OTHER_OPTION_VALUE
      ? String(state.otherAnswers?.[question.id] ?? '') : item);
  }
  return value;
}

function validationMessage(state, question) {
  if (!question) return 'Answer the highlighted question';
  const value = state.answers[question.id];
  const choseOther = question.type === 'multi'
    ? value?.includes(OTHER_OPTION_VALUE) : value === OTHER_OPTION_VALUE;
  if (choseOther && !String(state.otherAnswers?.[question.id] ?? '').trim()) {
    return 'Type your answer for Something else';
  }
  if (question.type === 'multi') {
    const count = Array.isArray(value) ? value.length : 0;
    if (count < question.minSelections) return `Choose at least ${question.minSelections}`;
    if (count > question.maxSelections) return `Choose no more than ${question.maxSelections}`;
  }
  return question.type === 'text' ? 'Type an answer before continuing' : 'Choose one option before continuing';
}

function syncQuestionCursor(state) {
  const question = state.questions[state.index];
  if (!question) return;
  if (question.type === 'text') {
    state.textCursor = [...String(state.answers[question.id] ?? '')].length;
    state.choiceCursor = 0;
  } else {
    const value = question.type === 'multi' ? state.answers[question.id]?.[0] : state.answers[question.id];
    state.choiceCursor = Math.max(0, question.options.findIndex((option) => option.value === value));
  }
  state.cursorAnim.set(state.choiceCursor, true);
}

function syncOtherEditor(state) {
  const question = state.questions[state.index];
  const selected = question && (question.type === 'multi'
    ? state.answers[question.id]?.includes(OTHER_OPTION_VALUE)
    : state.answers[question.id] === OTHER_OPTION_VALUE);
  state.otherEditing = !!selected;
  state.otherQuestionId = selected ? question.id : null;
  if (selected) state.textCursor = [...String(state.otherAnswers?.[question.id] ?? '')].length;
}

function keepChoiceVisible(state, rows = 7) {
  if (state.choiceCursor < state.choiceScroll) state.choiceScroll = state.choiceCursor;
  if (state.choiceCursor >= state.choiceScroll + rows) state.choiceScroll = state.choiceCursor - rows + 1;
}

function pulseQuestionnaire(state) {
  state.pulse.set(1, true);
  state.pulse.set(0);
}

function deleteTextWord(state, question) {
  const chars = [...String(state.answers[question.id] ?? '')];
  let start = state.textCursor;
  while (start > 0 && /\s/.test(chars[start - 1])) start--;
  while (start > 0 && !/\s/.test(chars[start - 1])) start--;
  chars.splice(start, state.textCursor - start);
  state.textCursor = start;
  state.answers[question.id] = chars.join('');
}

function cloneAnswer(value, type) {
  return type === 'multi' ? [...(Array.isArray(value) ? value : [])] : value ?? (type === 'text' ? '' : null);
}

function cleanId(value) {
  return String(value ?? '').trim().replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}
