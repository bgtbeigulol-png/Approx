import { Type } from 'typebox';

const ModeParams = Type.Object({
  mode: Type.Union([Type.Literal('go'), Type.Literal('plan')]),
  reason: Type.Optional(Type.String({ description: 'Brief reason for changing mode.' })),
});

const TodoParams = Type.Object({
  id: Type.String({ description: 'Stable short identifier.' }),
  text: Type.String({ description: 'One concrete, verifiable task.' }),
  note: Type.Optional(Type.String({ description: 'Optional context, constraint, or verification detail for this Todo.' })),
  status: Type.Optional(Type.Union([
    Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed'),
  ])),
});

const PlanParams = Type.Object({
  action: Type.Union([
    Type.Literal('propose'), Type.Literal('replace'), Type.Literal('update_todo'),
    Type.Literal('set_notes'), Type.Literal('finish'),
  ]),
  intent: Type.Optional(Type.String({ description: 'What the user is actually trying to achieve.' })),
  approach: Type.Optional(Type.String({ description: 'Execution approach and key design choices.' })),
  todos: Type.Optional(Type.Array(TodoParams, { maxItems: 16 })),
  notes: Type.Optional(Type.String({ description: 'Private reminders for later turns.' })),
  id: Type.Optional(Type.String({ description: 'Todo identifier for update_todo.' })),
  status: Type.Optional(Type.Union([
    Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed'),
  ])),
  text: Type.Optional(Type.String({ description: 'Optional replacement todo text.' })),
  note: Type.Optional(Type.String({ description: 'Optional replacement Todo note; use an empty string to clear it.' })),
});

const OptionParams = Type.Object({
  value: Type.String(),
  label: Type.String(),
  description: Type.Optional(Type.String()),
});

const QuestionParams = Type.Object({
  id: Type.String(),
  label: Type.Optional(Type.String()),
  prompt: Type.String(),
  type: Type.Union([Type.Literal('single'), Type.Literal('multi'), Type.Literal('text')]),
  options: Type.Optional(Type.Array(OptionParams, { maxItems: 12 })),
  required: Type.Optional(Type.Boolean()),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionParams, { minItems: 1, maxItems: 5 }),
});

const ApprodeParams = Type.Object({
  reason: Type.String({ description: 'Plain-language reason this change to the active skill/prompt set helps the current task.' }),
  enableSkills: Type.Optional(Type.Array(Type.String(), { description: 'Skill names to turn on.' })),
  disableSkills: Type.Optional(Type.Array(Type.String(), { description: 'Skill names to turn off.' })),
  enablePrompts: Type.Optional(Type.Array(Type.String(), { description: 'Prompt names to turn on.' })),
  disablePrompts: Type.Optional(Type.Array(Type.String(), { description: 'Prompt names to turn off.' })),
});

function textResult(text, details = {}) {
  return { content: [{ type: 'text', text }], details };
}

export function createApproxHostTools(host) {
  return [
    {
      name: 'set_mode',
      label: 'Approx Mode',
      description: 'Switch Approx between Go and Plan. Enter Plan before solving a large, ambiguous, or design-heavy request.',
      promptSnippet: 'set_mode: switch between Go execution and Plan exploration.',
      promptGuidelines: [
        'For large or ambiguous work, call set_mode with mode="plan" before committing to implementation.',
        'Do not remain in Plan after an approved plan; the host returns to Go automatically.',
      ],
      parameters: ModeParams,
      executionMode: 'sequential',
      async execute(_id, params) {
        const mode = host.setAgentMode(params.mode, params.reason || 'model decision');
        return textResult(`Approx mode is now ${mode === 'plan' ? 'Plan' : 'Go'}.`, { mode });
      },
    },
    {
      name: 'update_plan',
      label: 'Approx Plan',
      description: 'Create and maintain the persistent execution plan, todo progress, and hidden working notes shown by Approx.',
      promptSnippet: 'update_plan: propose plans, keep todos accurate, and store concise private continuity in notes.',
      promptGuidelines: [
        'In Plan mode, explore intent and possibilities, then call update_plan action="propose" with intent, approach, todos, and notes.',
        'After proposing, stop execution and wait for user approval.',
        'During Go work, update todo status at the moment work starts or completes; replace stale todos when reality changes.',
        'Use set_notes for concise constraints, decisions, and continuity that should survive later turns but stay hidden from the user-facing todo strip; do not put user-visible progress narration there.',
        'Call finish only after every required todo is completed.',
      ],
      parameters: PlanParams,
      executionMode: 'sequential',
      async execute(_id, params) {
        const result = host.applyPlanTool(params);
        return textResult(result.message, result.state);
      },
    },
    {
      name: 'ask_questions',
      label: 'Ask Questions',
      description: 'Ask the user up to five organized questions using single choice, multiple choice, or free text. Prefer this whenever clarification is needed.',
      promptSnippet: 'ask_questions: collect up to five structured user answers.',
      promptGuidelines: [
        'Prefer ask_questions over prose questions when an answer is needed to continue.',
        'Ask only material questions and group independent questions into one call, never more than five.',
      ],
      parameters: QuestionnaireParams,
      executionMode: 'sequential',
      async execute(toolCallId, params, signal) {
        const result = await host.requestQuestions(toolCallId, params.questions, signal);
        if (result.cancelled) return textResult('User cancelled the question list.', result);
        const lines = result.answers.map((answer) => `${answer.id}: ${Array.isArray(answer.value) ? answer.value.join(', ') : answer.value}`);
        return textResult(lines.join('\n') || 'Question list submitted with no answers.', result);
      },
    },
    {
      name: 'manage_approde',
      label: 'Manage Approde',
      description: 'Request a change to the hot-swappable active set of skills and prompts. Requires explicit user approval before it takes effect. Use sparingly, only when the current task clearly needs a capability that is off, or when an active one is getting in the way.',
      promptSnippet: 'manage_approde: request user-approved enable/disable of skills and prompts.',
      promptGuidelines: [
        'Only request changes that materially help the current task; never toggle capabilities speculatively.',
        'Always give a concrete reason; the user sees it in the approval prompt.',
        'A disabled skill or prompt is genuinely unavailable — request it back on before relying on it.',
      ],
      parameters: ApprodeParams,
      executionMode: 'sequential',
      async execute(toolCallId, params, signal) {
        const changes = summarizeApprodeChanges(params);
        if (!changes.length) return textResult('No approde changes were specified.', { applied: false });
        const question = {
          id: 'approde-approval',
          label: 'Approde change',
          prompt: `The assistant wants to change the active set:\n${changes.map((c) => `  • ${c}`).join('\n')}\n\nReason: ${params.reason || '(none given)'}\n\nApprove this change?`,
          type: 'single',
          options: [
            { value: 'approve', label: 'Approve', description: 'Apply the change and continue.' },
            { value: 'reject', label: 'Reject', description: 'Keep the current set.' },
          ],
          required: true,
        };
        const result = await host.requestQuestions(toolCallId, [question], signal, {
          title: 'APPRODE CHANGE REQUEST',
          intro: 'The assistant is asking to hot-swap the active skills/prompts.',
        });
        if (result.cancelled) return textResult('Approde change cancelled.', { applied: false, ...result });
        const answer = result.answers?.[0]?.value;
        const decision = Array.isArray(answer) ? answer[0] : answer;
        if (decision !== 'approve') {
          return textResult('User rejected the approde change; the active set is unchanged.', { applied: false });
        }
        const state = await host.applyApprodeFromModel({
          enableSkills: params.enableSkills ?? [],
          disableSkills: params.disableSkills ?? [],
          enablePrompts: params.enablePrompts ?? [],
          disablePrompts: params.disablePrompts ?? [],
        });
        return textResult(`Approde updated and system prompt rebuilt. ${changes.join('; ')}.`, { applied: true, state });
      },
    },
  ];
}

function summarizeApprodeChanges(params = {}) {
  const out = [];
  for (const name of params.enableSkills ?? []) out.push(`enable skill "${name}"`);
  for (const name of params.disableSkills ?? []) out.push(`disable skill "${name}"`);
  for (const name of params.enablePrompts ?? []) out.push(`enable prompt "${name}"`);
  for (const name of params.disablePrompts ?? []) out.push(`disable prompt "${name}"`);
  return out;
}
