import { Spring } from './anim.js';

export function createCompactState() {
  return {
    seq: 0,
    active: false,
    phase: 'idle',
    reason: 'manual',
    startedAt: 0,
    finishedAt: 0,
    tokensBefore: null,
    tokensAfter: null,
    error: '',
    enter: new Spring(0, { stiff: 20, damp: 0.82 }),
    progress: new Spring(0, { stiff: 12, damp: 0.9 }),
    pulse: new Spring(0, { stiff: 18, damp: 0.72 }),
  };
}
