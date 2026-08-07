import { clamp } from './anim.js';
import { ATTR_BOLD, DEFAULT, strWidth } from './ansi.js';
import { wiper } from './draw.js';
import { BLOCK } from './glyphs.js';
import { selectionRanges, totalChars } from './app-geometry.js';
import { T, paper, drawPaperGrain, mix } from './theme.js';
import { drawCompact } from './ui/compact.js';
import { drawComposer, drawRewindConfirm } from './ui/composer.js';
import { drawDirectories } from './ui/directories.js';
import { drawHeader, HEADER_H } from './ui/header.js';
import { drawGit } from './ui/git.js';
import { drawJumpList } from './ui/jumplist.js';
import { drawPalette } from './ui/palette.js';
import { drawPlanPanel } from './ui/plan.js';
import { drawQuestionnaire } from './ui/questionnaire.js';
import { drawMessageQueue } from './ui/queue.js';
import { drawRail, drawRailLabel, railTicks, RAIL_W } from './ui/rail.js';
import { drawSessions } from './ui/sessions.js';
import { drawSettings } from './ui/settings.js';
import { drawSplash } from './ui/splash.js';
import { drawStatus, STATUS_H } from './ui/status.js';
import { drawTranscript, invalidateLayoutTree } from './ui/transcript.js';

/** Animation advancement and frame composition. */
export const renderMethods = {
  onResize() {
    this.s.resize(process.stdout.columns, process.stdout.rows);
    const width = this.bodyWidth();
    for (const message of this.st.msgs) {
      if (!message.streaming) continue;
      const previousTotal = message._total || 1;
      const progress = clamp((message.streamChars ?? 0) / previousTotal, 0, 1);
      message._total = totalChars(message, width);
      message.streamChars = progress * message._total;
    }
    invalidateLayoutTree(this.st.msgs);
    this.s.invalidate();
    this.clampScroll();
  },

  tick(dt, t, frame) {
    if (!this.alive) return;
    const st = this.st;
    st.age += dt * 1000;
    st.frames = frame;

    if (st.phase === 'splash') {
      st.splashMs += dt * 1000;
      const done = drawSplash(this.s, st.splashMs);
      this.s.flush();
      if (done === 1) {
        st.phase = 'main';
        st.age = 0;
        this.s.invalidate();
        if (!st.msgs.length) this.seed();
      }
      return;
    }

    this.update(dt, t);
    this.render(t);
    this.s.flush();
  },

  update(dt, t) {
    const st = this.st;
    const snap = st.reduceMotion;
    const followingTail = st.atBottom;
    const liveGrowth = this.flushLiveDelta();

    st.ctxUse.step(dt);
    st.focusAnim.step(dt);
    st.paletteAnim.step(dt);
    st.slashAnim.step(dt);
    st.railBulge.step(dt);
    st.railAmt.step(dt);
    st.settingsAnim.step(dt);
    st.settingsCursor.step(dt);
    st.settingsFlash.step(dt);
    st.jumpAnim.step(dt);
    st.sessionPicker.anim.step(dt);
    st.rewindAnim.step(dt);
    st.queueAnim.step(dt);
    st.queuePulse.step(dt);
    st.compact.enter.step(dt);
    st.compact.progress.step(dt);
    st.compact.pulse.step(dt);
    this.stepDirectoryPicker(dt);
    this.stepGitAnimations(dt);
    this.stepPlanAnimations(dt);
    this.stepQuestionnaireAnimations(dt);
    for (const item of st.messageQueue) {
      item.anim?.step(dt);
      item.y?.step(dt);
    }
    for (const ghost of st.queueGhosts) {
      ghost.anim?.step(dt);
      ghost.y?.step(dt);
    }
    this.pruneQueueGhosts();

    if (st.wipe > 0) {
      st.wipe += Math.min(dt, 0.033) * 2.2;
      if (st.wipe >= 1) st.wipe = 0;
    }
    if (snap) st.scrollSpring.set(st.scrollTarget, true);
    const maxBefore = this.maxScroll();
    st.scroll = clamp(st.scrollSpring.step(dt), 0, maxBefore);
    if ((st.scroll <= 0 && st.scrollSpring.vel < 0)
      || (st.scroll >= maxBefore && st.scrollSpring.vel > 0)) st.scrollSpring.vel = 0;

    for (const message of st.msgs) {
      if (message.enter < 1) message.enter = snap ? 1 : Math.min(1, message.enter + dt * 3.4);
      message._selectAnim?.step(dt);
    }

    let anyStream = false;
    let scriptedTps = 0;
    let toolHeightMoving = false;
    for (const message of st.msgs) {
      if (message.streaming) {
        anyStream = true;
        if (!message._live) scriptedTps += (message._cps ?? 190) / 4;
        message.streamChars = (message.streamChars ?? 0) + (message._cps ?? 190) * dt;
        if (message._total == null) message._total = totalChars(message, this.bodyWidth());
        if (message.streamChars >= message._total) this.finishStream(message);
      }
      for (const tool of animatedToolNodes(message)) {
        if (tool.running && tool._dur) {
          tool._t = (tool._t ?? 0) + dt * 1000;
          tool.progress = clamp(tool._t / tool._dur, 0, 1);
        }
        if (!tool.expandAnim) continue;
        const before = tool.expandAnim.v;
        tool.expandAnim.step(dt);
        if (Math.abs(before - tool.expandAnim.v) > 0.0001) toolHeightMoving = true;
      }
    }

    if (st.busy) st.elapsed += dt;
    if (Math.floor(t * 8) !== this._lastTps) {
      this._lastTps = Math.floor(t * 8);
      const cutoff = t - 1;
      this._tokenEvents = this._tokenEvents.filter((sample) => sample.at >= cutoff);
      const liveTps = this._tokenEvents.reduce((sum, sample) => sum + sample.tokens, 0);
      st.tpsNow = liveTps > 0 ? liveTps : (anyStream ? scriptedTps : 0);
      st.tps.shift();
      st.tps.push(st.tpsNow);
    }

    if (st.toastLife > 0) {
      st.toastLife -= dt;
      if (st.toastLife <= 0) st.toast = null;
    }

    const max = this.maxScroll();
    if (followingTail) {
      st.scrollTarget = max;
      const lock = liveGrowth || anyStream || toolHeightMoving || this.liveTools.size > 0;
      st.scrollSpring.set(max, snap || lock);
      if (lock) st.scroll = max;
    }
    st.scrollPct = max === 0 ? 1 : clamp(st.scrollTarget / max, 0, 1);
    st.atBottom = max === 0 || st.scrollTarget >= max - 0.5;
    if (st.scrollTarget > max) this.clampScroll();
  },

  render(t) {
    const s = this.s;
    const st = this.st;
    s.clear(T.bg, T.fg);
    if (st.grain) drawPaperGrain(s);

    drawHeader(s, st, t);
    const vp = this.viewport();
    drawTranscript(s, st.msgs, vp.x, vp.y, vp.w, vp.h, Math.round(st.scroll), t);
    if (st.textSelection) {
      for (const range of selectionRanges(st.textSelection, vp)) {
        for (let x = range.x1; x <= range.x2; x++) {
          const i = range.y * s.w + x;
          s.tint(x, range.y, DEFAULT, mix(s.bg[i], T.accent, st.textSelection.active ? 0.24 : 0.16));
        }
      }
    }
    this.drawScrollbar(vp);

    st.railTicks = railTicks(st.msgs, this.bodyWidth(), vp.h, { logical: true });
    const scroll = Math.round(st.scroll);
    const hover = this.railHoverTick();
    if (hover) st.railBulge.set(hover.row);
    drawRail(s, st.railTicks, 0, vp.y, vp.h, {
      bulge: st.railBulge.v,
      amt: st.railAmt.v,
      hoverIndex: st.railHover,
      view: { top: scroll, bottom: scroll + vp.h },
    });

    if (st.wipe > 0) {
      wiper(s, 0, vp.y, s.w, vp.h, st.wipe, st.wipeDir,
        st.grain ? paper : null, T.accent);
    }
    if (hover) {
      const row = clamp(hover.row, 0, vp.h - 1);
      drawRailLabel(s, hover, RAIL_W, vp.y + row, st.railAmt.v, s.w - RAIL_W - 2);
    }

    const cy = s.h - STATUS_H - vp.composerH - 1;
    const qy = cy - vp.queuedH - (vp.queuedH ? 1 : 0);
    const planY = qy - vp.planH - (vp.planH ? 1 : 0);
    if (vp.planH) drawPlanPanel(s, st, 1, planY, s.w - 2, t, vp.planH);
    if (vp.queuedH) drawMessageQueue(s, st, 1, qy, s.w - 2, t);
    // The composer owns the top interaction layer so its slash hint can overlap
    // the plan/queue stack without being painted over by those panels.
    drawComposer(s, st, 1, cy, s.w - 2, t);
    if (st.rewindAnim.v > 0.001) drawRewindConfirm(s, st, 1, planY - 4, s.w - 2, t);

    drawStatus(s, st, s.h - 1, t);
    if (st.showFps) this.drawFps();
    if (st.paletteAnim.v > 0.001) drawPalette(s, st, t);
    if (st.settingsAnim.v > 0.001) drawSettings(s, st, t);
    if (st.jumpAnim.v > 0.001) drawJumpList(s, st, t);
    if (st.sessionPicker.anim.v > 0.001) drawSessions(s, st, t);
    if (st.directoryPicker.anim.v > 0.001) drawDirectories(s, st, t);
    if (st.compact.enter.v > 0.001) drawCompact(s, st, t);
    if (st.git.anim.v > 0.001) drawGit(s, st, t);
    if (st.questionnaire.anim.v > 0.001) drawQuestionnaire(s, st, t);
  },

  drawScrollbar(vp) {
    const st = this.st;
    const max = this.maxScroll();
    const x = this.s.w - 1;
    if (max <= 0) return;
    const h = vp.h;
    const doc = this.docHeight();
    const thumb = Math.max(1, Math.round((h / doc) * h));
    const top = Math.round((st.scroll / max) * (h - thumb));
    for (let i = 0; i < h; i++) {
      const on = i >= top && i < top + thumb;
      this.s.put(x, vp.y + i, on ? BLOCK.l4 : BLOCK.l1, on ? T.accent : mix(T.bg, T.sand, 0.55));
    }
  },

  drawFps() {
    const s = this.s;
    const now = performance.now();
    this._fpsWin = this._fpsWin ?? [];
    this._fpsWin.push(now);
    while (this._fpsWin.length > 30) this._fpsWin.shift();
    const span = (this._fpsWin[this._fpsWin.length - 1] - this._fpsWin[0]) / 1000;
    const fps = span > 0 ? (this._fpsWin.length - 1) / span : 0;
    const text = ` ${fps.toFixed(0)}fps `;
    s.text(s.w - strWidth(text) - 1, HEADER_H, text, T.bg, mix(T.fg, T.bg, 0.3), ATTR_BOLD);
  },
};

function animatedToolNodes(message) {
  if (message.role === 'system' && message.subtype === 'changeset') return [message];
  if (message.role === 'tool') return [message];
  if (message.role === 'toolgroup') return [message, ...(message.tools ?? [])];
  if (message.role === 'workgroup') {
    return [message, ...(message.tools ?? []), ...(message.tools ?? []).flatMap((group) => group.tools ?? [])];
  }
  return [];
}
