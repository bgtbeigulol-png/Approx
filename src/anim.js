// Animation core: easings, critically-damped springs, tweens, and a clock.

export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  outQuint: (t) => 1 - (1 - t) ** 5,
  outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inOutExpo: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,
  outBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  outElastic: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * (2 * Math.PI)) / 3) + 1,
  outBounce: (t) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Map v from [a,b] into [0,1], clamped. */
export const norm = (v, a, b) => clamp((v - a) / (b - a || 1), 0, 1);
/** Smooth 0..1 ramp between edges. */
export const smooth = (e0, e1, v) => {
  const t = norm(v, e0, e1);
  return t * t * (3 - 2 * t);
};

/** Second-order spring. `stiff` in Hz-ish units, `damp` 1 = critical. */
export class Spring {
  constructor(value = 0, { stiff = 12, damp = 0.85 } = {}) {
    this.v = value;
    this.target = value;
    this.vel = 0;
    this.stiff = stiff;
    this.damp = damp;
  }

  set(target, snap = false) {
    this.target = target;
    if (snap) {
      this.v = target;
      this.vel = 0;
    }
    return this;
  }

  step(dt) {
    // Semi-implicit Euler is stable at normal frame rates, but one 250ms stall
    // used to turn a scroll spring into a slingshot. Substep long frames so every
    // animation keeps the same damping instead of accumulating explosive velocity.
    const elapsed = clamp(Number(dt) || 0, 0, 0.25);
    const steps = Math.max(1, Math.ceil(elapsed / (1 / 120)));
    const h = elapsed / steps;
    const k = this.stiff * this.stiff;
    const c = 2 * this.damp * this.stiff;
    for (let i = 0; i < steps; i++) {
      const a = k * (this.target - this.v) - c * this.vel;
      this.vel += a * h;
      this.v += this.vel * h;
    }
    if (!Number.isFinite(this.v) || !Number.isFinite(this.vel)) {
      this.v = this.target;
      this.vel = 0;
    }
    if (Math.abs(this.target - this.v) < 1e-4 && Math.abs(this.vel) < 1e-3) {
      this.v = this.target;
      this.vel = 0;
    }
    return this.v;
  }

  get settled() {
    return this.v === this.target && this.vel === 0;
  }
}

/** One-shot tween driven by elapsed wall time. */
export class Tween {
  constructor({ from = 0, to = 1, dur = 300, easing = ease.outCubic, delay = 0 } = {}) {
    this.from = from;
    this.to = to;
    this.dur = Math.max(1, dur);
    this.easing = easing;
    this.delay = delay;
    this.t = 0;
  }

  step(dt) {
    this.t += dt * 1000;
    return this.value;
  }

  get p() {
    return clamp((this.t - this.delay) / this.dur, 0, 1);
  }

  get value() {
    return lerp(this.from, this.to, this.easing(this.p));
  }

  get done() {
    return this.t - this.delay >= this.dur;
  }
}

/** Staggered index delay helper: item i starts at i*step ms. */
export const stagger = (i, step = 45) => i * step;

/** Fixed-step render clock with dt in seconds. */
export class Clock {
  constructor(fps = 30) {
    this.interval = 1000 / fps;
    this.last = 0;
    this.t = 0;
    this.frame = 0;
    this.timer = null;
    this.onTick = null;
  }

  start(onTick) {
    this.onTick = onTick;
    this.last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      let dt = (now - this.last) / 1000;
      this.last = now;
      if (dt > 0.25) dt = 0.25; // clamp after a stall
      this.t += dt;
      this.frame++;
      this.onTick(dt, this.t, this.frame);
    }, this.interval);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
