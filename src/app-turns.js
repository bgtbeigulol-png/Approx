import { Spring } from './anim.js';
import { setComposerInput } from './composer-state.js';
import { HELP, SAMPLE_ANSWER } from './content.js';

/** User-turn submission, backend dispatch, and offline scripted actions. */
export const turnMethods = {
  submit() {
    const raw = this.st.input.trim();
    if (!raw) return;
    if (this.st.messageEdit.mode === 'editing') return this.prepareMessageRewind(raw);
    const accepted = this.submitText(raw, 'user');
    if (accepted === false) return;
    setComposerInput(this.st, '');
    this.st.slashMatches = [];
    this.closeFileMention?.();
    this.syncComposerSuggestionAnimation?.();
    this.st.history.push(raw);
    this.st.histIdx = -1;
  },

  submitText(raw, source = 'user') {
    raw = String(raw).trim();
    if (!raw) return;

    if (raw.startsWith('/')) {
      const parts = raw.slice(1).split(/\s+/);
      const name = parts.shift().toLowerCase();
      const arg = parts.join(' ').trim();
      const command = this.cmds.find((candidate) => candidate.name === name);
      if (command) {
        this.later(() => command.run(arg), 40);
        return true;
      }
      if (!this.backend && !this.harness?.attached) {
        this.push({ role: 'user', text: raw });
        this.push({ role: 'system', text: `unknown command: /${name}  ·  try /help` });
        return true;
      }
    }

    return this.sendTurn(raw, { source });
  },

  sendTurn(raw, { push = true, userMessage = null, source = 'user' } = {}) {
    if (this.turnInFlight()) return this.enqueueTurn(raw, source);
    this.dispatchTurn(raw, { push, userMessage, source });
    return true;
  },

  dispatchTurn(raw, { push = true, userMessage = null, source = 'user', queued = false } = {}) {
    const turn = {
      id: ++this._turnSeq,
      text: raw,
      source,
      queued,
      finalDelivered: false,
      runtimeSettled: false,
      promiseDone: false,
      interrupted: false,
      failed: false,
      releasing: false,
      mutations: [],
      mutationCallIds: [],
    };
    this._activeTurn = turn;
    const landed = push ? this.push({ role: 'user', text: raw, _awaitEntry: !!this.backend }) : userMessage;
    this.st.busy = true;
    this.st.elapsed = 0;
    this.scrollToBottom();
    if (this.harness) this.harness.emit({ event: 'submit', text: raw });

    if (this.harness?.attached) {
      turn.promiseDone = true;
      this.harness.emit({ event: 'needReply', text: raw });
      return landed;
    }
    if (this.backend) {
      try {
        const request = this.backend.prompt(raw);
        void Promise.resolve(request)
          .then(() => this.notePromptPromiseDone(turn, false))
          .catch(() => this.notePromptPromiseDone(turn, true));
      } catch {
        this.notePromptPromiseDone(turn, true);
      }
      return landed;
    }
    turn.promiseDone = true;
    this.later(() => this.replyTo(raw), 420);
    return landed;
  },

  replyTo(prompt) {
    const words = prompt.split(/\s+/).length;
    const wantsTool = /\b(run|build|test|check|measure|search|find|list)\b/i.test(prompt);
    if (wantsTool) {
      const tool = this.push({
        role: 'tool',
        name: prompt.split(/\s+/)[0].toLowerCase(),
        meta: 'simulated',
        text: 'no real execution — this shell has no backend',
        running: true,
        progress: 0,
        expanded: false,
        expandAnim: new Spring(0, { stiff: 18, damp: 0.86 }),
      });
      this.st.toolFocus = tool;
      tool._dur = 1100;
      tool._t = 0;
      this.st.busy = true;
      this.later(() => {
        tool.running = false;
        tool.progress = null;
        this.beginStream(pickAnswer(prompt, words));
      }, 1150);
      return;
    }
    this.beginStream(pickAnswer(prompt, words));
  },

  fakeStream() {
    this.beginStream(SAMPLE_ANSWER, 220);
  },

  fakeTool() {
    const tool = this.push({
      role: 'tool',
      name: 'measure',
      meta: 'frame budget',
      text: 'dirty cells/frame  avg 41  peak 388\nflush 0.21ms avg\nno frame exceeded the 33ms budget',
      running: true,
      progress: 0,
      expanded: false,
      expandAnim: new Spring(0, { stiff: 18, damp: 0.86 }),
    });
    this.st.toolFocus = tool;
    tool._dur = 1400;
    tool._t = 0;
    this.st.busy = true;
    this.later(() => {
      tool.running = false;
      tool.progress = null;
      this.st.busy = false;
      this.toast('tool finished', 'ok');
    }, 1450);
  },

  showHelp() {
    this.push({ role: 'guest', text: HELP });
    this.scrollToBottom();
  },

};

function pickAnswer(prompt, words) {
  if (words <= 2) {
    return `Short prompt, short answer: this shell has no model behind it, so what you get is scripted text streaming through the real renderer.\n\nTry \`/help\` for keys.`;
  }
  return SAMPLE_ANSWER;
}
