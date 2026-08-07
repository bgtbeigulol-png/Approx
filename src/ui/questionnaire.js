import { ATTR_BOLD, ATTR_DIM, strWidth } from '../ansi.js';
import { BLOCK, HEAVY, LIGHT, MARK } from '../glyphs.js';
import { T, mix } from '../theme.js';
import { clamp, ease } from '../anim.js';
import { panel, box, ruleFade, shimmer } from '../draw.js';
import { ellipsize, wrapText } from '../wrap.js';
import { layoutComposerInput } from '../composer-state.js';
import { OTHER_OPTION_VALUE } from '../questionnaire.js';

export function questionnaireLayout(w, h, state, p = 1) {
  const question = state?.questions?.[state.index];
  const editingOther = !!question && state?.otherEditing && state.otherQuestionId === question.id;
  const optionRows = question?.type === 'text' ? 4
    : Math.min(7, question?.options?.length ?? 1) + (editingOther ? 4 : 0);
  const promptRows = Math.min(3, wrapText(question?.prompt ?? '', Math.max(10, Math.min(66, w - 10))).length || 1);
  const desiredH = 8 + promptRows + optionRows + (question?.description ? 1 : 0) + (state?.intro ? 1 : 0);
  const pw = clamp(Math.min(76, w - 4), 18, Math.max(18, w - 2));
  const ph = Math.min(h, Math.max(Math.min(8, h), Math.min(desiredH, Math.max(8, h - 2))));
  const reveal = ease.outBack(clamp(p, 0, 1));
  const shake = Math.round((state?.shake?.v ?? 0) * 2);
  const px = clamp(Math.floor((w - pw) / 2) + shake, 0, Math.max(0, w - pw));
  const restingY = Math.max(1, Math.floor((h - ph) / 2));
  const py = clamp(restingY + Math.round((1 - reveal) * 4), 0, Math.max(0, h - ph));
  return { px, py, pw, ph, reveal };
}

export function drawQuestionnaire(s, st, t) {
  const state = st?.questionnaire;
  if (!state) return null;
  const p = clamp(state.anim?.v ?? (state.open ? 1 : 0), 0, 1);
  if (p <= 0.002) {
    state.hits = [];
    state.geometry = null;
    return null;
  }
  const question = state.questions?.[state.index];
  if (!question) return null;
  s.clearCursorAnchor();

  const g = questionnaireLayout(s.w, s.h, state, p);
  state.hits = [];
  state.geometry = { x: g.px, y: g.py, w: g.pw, h: g.ph };

  // Fade every underlying cell toward one veil color. Matching foreground and
  // background at rest keeps clipped transcript glyphs from leaking around the
  // takeover panel while still giving the entrance a real dissolve.
  const wash = ease.outCubic(p);
  const veilBg = mix(T.bg, T.shadow, 0.12);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      s.fg[i] = mix(s.fg[i] < 0 ? T.fg : s.fg[i], veilBg, wash);
      s.bg[i] = mix(s.bg[i] < 0 ? T.bg : s.bg[i], veilBg, wash);
    }
  }

  const { px, py, pw, ph } = g;
  const pulse = clamp(state.pulse?.v ?? 0, 0, 1);
  const bg = mix(T.cream, T.bg, 0.08);
  const border = mix(T.accent2, T.accent, 0.32 + pulse * 0.28);
  panel(s, px, py, pw, ph, {
    bg,
    border,
    style: HEAVY,
    shadow: true,
    shadowOff: 2,
    shadowColor: mix(T.bg, T.pitch, 0.42 * p),
    label: 'ASK / RESOLVE',
    labelColor: T.accent,
  });

  const cancelText = ` ${MARK.cross} CANCEL `;
  const cancelX = px + pw - strWidth(cancelText) - 2;
  s.text(cancelX, py, cancelText, T.bg, mix(bg, T.accent, 0.82 * p), ATTR_BOLD);
  state.hits.push({ kind: 'cancel', x1: cancelX, x2: cancelX + strWidth(cancelText) - 1, y: py });

  let y = py + 1;
  const innerX = px + 3;
  const innerW = Math.max(8, pw - 6);
  const ordinal = `${String(state.index + 1).padStart(2, '0')} / ${String(state.questions.length).padStart(2, '0')}`;
  s.text(innerX, y, ordinal, T.bg, T.accent2, ATTR_BOLD);
  const titleX = innerX + strWidth(ordinal) + 2;
  s.text(titleX, y, ellipsize(state.title, Math.max(1, innerX + innerW - titleX)), T.fg, bg, ATTR_BOLD);

  drawStepRail(s, state, px, y, pw, bg, p);
  y++;
  ruleFade(s, px + 1, y, pw - 2, border, bg, 0);
  y++;

  if (state.intro && y < py + ph - 5) {
    s.put(innerX, y, MARK.star, mix(bg, T.plum, p), bg, ATTR_BOLD);
    s.text(innerX + 2, y, ellipsize(state.intro.replace(/\s+/g, ' '), innerW - 2),
      mix(bg, T.dim, p), bg, ATTR_DIM);
    y++;
  }

  const qP = ease.outCubic(clamp(state.stepAnim?.v ?? 1, 0, 1));
  const qShift = st.reduceMotion ? 0 : Math.round((1 - qP) * 5) * (state.direction || 1);
  const promptLines = wrapText(question.prompt, Math.max(8, innerW - 2)).slice(0, 3);
  for (let i = 0; i < promptLines.length && y < py + ph - 5; i++, y++) {
    if (i === 0) s.put(innerX + qShift, y, MARK.tri_r, mix(bg, T.accent, qP), bg, ATTR_BOLD);
    s.text(innerX + 2 + qShift, y, promptLines[i], mix(bg, T.fg, qP), bg, i === 0 ? ATTR_BOLD : 0,
      Math.max(1, innerW - 2 - Math.abs(qShift)));
  }
  if (question.description && y < py + ph - 5) {
    s.text(innerX + 2 + qShift, y, ellipsize(question.description.replace(/\s+/g, ' '), innerW - 2),
      mix(bg, T.dim, qP), bg, ATTR_DIM);
    y++;
  }

  const footerY = py + ph - 2;
  const bodyTop = y;
  const bodyRows = Math.max(1, footerY - bodyTop);
  if (question.type === 'text') drawTextQuestion(s, state, question, innerX, bodyTop, innerW, bodyRows, bg, t, qP);
  else drawChoiceQuestion(s, state, question, innerX, bodyTop, innerW, bodyRows, bg, t, qP);

  drawQuestionFooter(s, state, px, footerY, pw, bg, p);
  if (state.open) shimmer(s, px + 1, py + ph - 1, pw - 2, t, border, T.accent, 13, 7);
  return g;
}

export const drawQuestionChecklist = drawQuestionnaire;

function drawStepRail(s, state, px, y, pw, bg, p) {
  const total = state.questions.length;
  const cellW = 3;
  const width = total * cellW;
  let x = px + pw - width - 3;
  if (x < px + 22) return;
  for (let i = 0; i < total; i++) {
    const answered = isAnswered(state, state.questions[i]);
    const current = i === state.index;
    const color = current ? T.accent : answered ? T.ok : T.rule;
    const text = current ? `${MARK.diamond}${i + 1}` : answered ? `${MARK.check}${i + 1}` : `${MARK.dot}${i + 1}`;
    s.text(x, y, text, mix(bg, color, p), bg, current ? ATTR_BOLD : ATTR_DIM, cellW);
    state.hits.push({ kind: 'step', index: i, x1: x, x2: x + cellW - 1, y });
    x += cellW;
  }
}

function drawChoiceQuestion(s, state, question, x, y, w, rows, bg, t, p) {
  const options = question.options;
  const editingOther = state.otherEditing && state.otherQuestionId === question.id;
  const otherRows = editingOther && rows >= 4 ? 3 : 0;
  const visibleRows = Math.max(1, Math.min(rows - otherRows, 7));
  if (state.choiceCursor < state.choiceScroll) state.choiceScroll = state.choiceCursor;
  if (state.choiceCursor >= state.choiceScroll + visibleRows) {
    state.choiceScroll = state.choiceCursor - visibleRows + 1;
  }
  state.choiceScroll = clamp(state.choiceScroll, 0, Math.max(0, options.length - visibleRows));
  const shown = options.slice(state.choiceScroll, state.choiceScroll + visibleRows);
  const answer = state.answers[question.id];

  for (let row = 0; row < shown.length; row++) {
    const index = state.choiceScroll + row;
    const option = shown[row];
    const selected = index === state.choiceCursor;
    const chosen = question.type === 'multi' ? answer?.includes(option.value) : answer === option.value;
    const ry = y + row;
    const rowBg = selected ? mix(bg, T.accent2, 0.18) : bg;
    s.fillRect(x, ry, w, 1, ' ', T.fg, rowBg);
    if (selected) {
      s.put(x, ry, BLOCK.full, mix(rowBg, T.accent, p), rowBg, ATTR_BOLD);
      shimmer(s, x + 1, ry, Math.max(1, w - 1), t, T.rule, T.accent2, 8, 4);
    } else s.put(x, ry, BLOCK.l1, mix(rowBg, chosen ? T.ok : T.rule, p), rowBg);
    const marker = chosen ? (question.type === 'multi' ? MARK.check : MARK.diamond)
      : (question.type === 'multi' ? MARK.sq_o : MARK.dia_o);
    const markColor = chosen ? T.ok : selected ? T.accent : T.dim;
    s.put(x + 2, ry, marker, mix(rowBg, markColor, p), rowBg, ATTR_BOLD);
    const number = String(index + 1).padStart(2, '0');
    s.text(x + 4, ry, number, mix(rowBg, selected ? T.accent2 : T.dim, p), rowBg, ATTR_BOLD);
    const labelX = x + 7;
    const desc = option.description?.replace(/\s+/g, ' ');
    const descRoom = desc && w >= 44 ? Math.min(Math.floor(w * 0.38), strWidth(desc) + 1) : 0;
    const labelW = Math.max(1, w - 8 - descRoom);
    s.text(labelX, ry, ellipsize(option.label, labelW), mix(rowBg, T.fg, p), rowBg,
      selected ? ATTR_BOLD : 0, labelW);
    if (descRoom) s.textRight(x + w - 2, ry, ellipsize(desc, descRoom), mix(rowBg, T.dim, p), rowBg, ATTR_DIM);
    state.hits.push({ kind: 'choice', index, x1: x, x2: x + w - 1, y: ry });
  }

  if (options.length > visibleRows) {
    const trackX = x + w - 1;
    const pos = Math.round((state.choiceCursor / Math.max(1, options.length - 1)) * (visibleRows - 1));
    for (let i = 0; i < visibleRows; i++) {
      s.put(trackX, y + i, i === pos ? BLOCK.full : BLOCK.l1,
        mix(bg, i === pos ? T.accent : T.rule, p), bg);
    }
  }

  if (otherRows) {
    drawOtherChoiceInput(s, state, question, x, y + visibleRows, w, otherRows, bg, t, p);
  }

  if (!otherRows && state.validation && y + visibleRows < y + rows) {
    s.text(x + 2, y + visibleRows, ellipsize(`${MARK.tri_r} ${state.validation}`, w - 3),
      mix(bg, T.warn, p), bg, ATTR_BOLD);
  }
}

function drawOtherChoiceInput(s, state, question, x, y, w, h, bg, t, p) {
  const wellBg = mix(bg, T.inset, 0.52);
  const border = state.validation ? T.warn : mix(T.rule, T.accent, 0.58);
  s.fillRect(x, y, w, h, ' ', T.fg, wellBg);
  box(s, x, y, w, h, LIGHT, mix(wellBg, border, p), wellBg);
  state.hits.push({ kind: 'other-text', x1: x, x2: x + w - 1, y: y + 1 });

  const input = String(state.otherAnswers?.[question.id] ?? '');
  const innerW = Math.max(1, w - 4);
  const layout = layoutComposerInput(input, innerW, state.textCursor);
  const line = layout.lines[layout.cursorRow] ?? '';
  s.text(x + 2, y + 1, ellipsize(line, innerW), mix(wellBg, T.fg, p), wellBg, 0, innerW);
  if (!input) {
    s.text(x + 2, y + 1, ellipsize('Type your own answer…', innerW),
      mix(wellBg, T.dim, 0.8 * p), wellBg, ATTR_DIM);
  }
  const cursorX = x + 2 + clamp(layout.cursorCol, 0, Math.max(0, innerW - 1));
  s.put(cursorX, y + 1, BLOCK.full,
    mix(wellBg, T.accent, 0.94 * p), wellBg, ATTR_BOLD);
  s.setCursorAnchor(cursorX, y + 1);
  if (state.validation) {
    s.text(x + 2, y + h - 1, ellipsize(state.validation, Math.max(1, w - 4)),
      mix(wellBg, T.warn, p), wellBg, ATTR_BOLD);
  }
}

function drawTextQuestion(s, state, question, x, y, w, rows, bg, t, p) {
  const h = Math.max(3, rows);
  const wellBg = mix(bg, T.inset, 0.52);
  const border = state.validation ? T.warn : mix(T.rule, T.accent2, 0.52);
  s.fillRect(x, y, w, h, ' ', T.fg, wellBg);
  box(s, x, y, w, h, LIGHT, mix(wellBg, border, p), wellBg);
  state.hits.push({ kind: 'text', x1: x, x2: x + w - 1, y: y + 1 });

  const input = String(state.answers[question.id] ?? '');
  const displayInput = question.secret ? [...input].map(() => '•').join('') : input;
  const innerW = Math.max(1, w - 4);
  const innerRows = Math.max(1, h - 2);
  const layout = layoutComposerInput(displayInput, innerW, state.textCursor);
  const start = clamp(layout.cursorRow - innerRows + 1, 0, Math.max(0, layout.lines.length - innerRows));
  for (let i = 0; i < innerRows; i++) {
    const line = layout.lines[start + i] ?? '';
    s.text(x + 2, y + 1 + i, line, mix(wellBg, T.fg, p), wellBg, 0, innerW);
  }
  if (!input) {
    const placeholder = question.placeholder || 'Type the context that changes the decision…';
    s.text(x + 2, y + 1, ellipsize(placeholder, innerW), mix(wellBg, T.dim, 0.8 * p), wellBg, ATTR_DIM);
  }

  const cursorRow = clamp(layout.cursorRow - start, 0, innerRows - 1);
  const cursorX = x + 2 + layout.cursorCol;
  if (cursorX < x + w - 1) {
    s.put(cursorX, y + 1 + cursorRow, BLOCK.full,
      mix(wellBg, T.accent, 0.94 * p), wellBg, ATTR_BOLD);
  }
  s.setCursorAnchor(Math.min(x + w - 2, cursorX), y + 1 + cursorRow);

  const meter = ` ${[...input].length}/${question.maxLength} `;
  if (strWidth(meter) + 5 < w) s.textRight(x + w - 2, y + h - 1, meter, mix(wellBg, T.dim, p), wellBg, ATTR_DIM);
  if (state.validation) {
    s.text(x + 2, y + h - 1, ellipsize(state.validation, Math.max(1, w - strWidth(meter) - 5)),
      mix(wellBg, T.warn, p), wellBg, ATTR_BOLD);
  }
}

function drawQuestionFooter(s, state, px, y, pw, bg, p) {
  const footerBg = mix(bg, T.inset, 0.34);
  s.fillRect(px + 1, y, pw - 2, 1, ' ', T.fg, footerBg);
  const back = ` ${MARK.arrow_l} BACK `;
  const next = state.index === state.questions.length - 1 ? ` SUBMIT ${MARK.check} ` : ` NEXT ${MARK.arrow} `;
  const backX = px + 2;
  const nextX = px + pw - strWidth(next) - 2;
  const backFg = state.index > 0 ? T.bg : mix(footerBg, T.dim, 0.65);
  const backBg = state.index > 0 ? mix(footerBg, T.accent2, 0.72 * p) : footerBg;
  s.text(backX, y, back, backFg, backBg, state.index > 0 ? ATTR_BOLD : ATTR_DIM);
  s.text(nextX, y, next, T.bg, mix(footerBg, state.index === state.questions.length - 1 ? T.ok : T.accent, 0.86 * p), ATTR_BOLD);
  state.hits.push({ kind: 'back', x1: backX, x2: backX + strWidth(back) - 1, y });
  state.hits.push({ kind: 'next', x1: nextX, x2: nextX + strWidth(next) - 1, y });

  const question = state.questions[state.index];
  const hint = state.otherEditing && state.otherQuestionId === question.id
    ? 'type answer · enter continues · ↑↓ choices'
    : question.type === 'multi' ? 'space toggles · enter continues'
    : question.type === 'single' ? '↑↓ choose · enter continues'
      : 'enter continues · shift+enter newline';
  const hintX = backX + strWidth(back) + 2;
  const hintW = nextX - hintX - 2;
  if (hintW > 10) s.text(hintX, y, ellipsize(hint, hintW), mix(footerBg, T.dim, p), footerBg, ATTR_DIM);
}

function isAnswered(state, question) {
  const value = state.answers[question.id];
  if (question.type === 'text') return String(value ?? '').trim().length > 0;
  if (question.type === 'multi') {
    if (!Array.isArray(value) || value.length < question.minSelections) return false;
    return !value.includes(OTHER_OPTION_VALUE)
      || String(state.otherAnswers?.[question.id] ?? '').trim().length > 0;
  }
  if (value === OTHER_OPTION_VALUE) return String(state.otherAnswers?.[question.id] ?? '').trim().length > 0;
  return value != null;
}
