// game.js — the PoSports meet orchestrator for the LOCAL modes (1p, 2p, demo).
// Owns the canvas, the fixed-step 60 Hz sim loop, lane state (via physics.js — the
// same stride model the server runs for online races), AI rivals, animation
// selection, and the Blazor interop callbacks. Online races replace this loop with
// server snapshots (remote mode, driven through applySnapshot).
import {
  CONSTANTS, HURDLE_POSITIONS, createLane, resetLane,
  applyImpulse, applyFalseStart, startJump, tickLane,
} from './physics.js';
import { SequenceTracker, attachKeyboard, LAYOUTS } from './input.js';
import { AiTypist, makeRng } from './ai.js';
import { TrackRenderer } from './track.js';
import * as sprites from './sprites.js';
import { TouchPad, isTouchDevice } from './touch.js';

const COUNTDOWN_SECONDS = 3;
const PODIUM_SECONDS = 6;      // how long the podium holds before demo auto-restart
const HUD_THROTTLE_MS = 250;
const FIXED_DT = CONSTANTS.TICK;

/** Anims every meet needs; punch/kick stay unused until a Dodgeball event exists. */
const MEET_ANIMS = ['idle', 'walk', 'run', 'jump', 'hitreact', 'dance'];

export class SportsGame {
  /**
   * @param {HTMLElement} container
   * @param {any} dotnetRef Blazor object reference (OnHud/OnLegDone/OnMeetDone/OnPhase)
   * @param {{
   *   mode: '1p'|'2p'|'demo',
   *   players: Array<{character: string, name: string, human: boolean, layout?: 1|2}>,
   *   difficulty?: 'easy'|'medium'|'hard',
   *   seed?: number,
   * }} options
   */
  constructor(container, dotnetRef, options) {
    this.container = container;
    this.dotnet = dotnetRef;
    this.options = options;
    this.mode = options.mode ?? '1p';
    this.rng = makeRng(options.seed ?? ((Math.random() * 2 ** 31) | 0));

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ps-canvas';
    container.appendChild(this.canvas);
    this.renderer = new TrackRenderer(this.canvas);

    this.remote = false;        // flips true when applySnapshot drives the meet
    this.phase = 'loading';
    this.phaseClock = 0;
    this.lastHudAt = 0;
    this.disposed = false;
    this._raf = 0;
    this._detachKeys = null;

    this.lanes = (options.players ?? []).map((p, i) => this.buildLane(p, i));
  }

  buildLane(p, index) {
    const lane = {
      index,
      name: p.name,
      character: p.character,
      human: !!p.human,
      state: createLane(),
      animTime: 0,
      currentAnim: 'idle',
      sprintSeconds: -1,
      hurdlesSeconds: -1,
      placing: 0,
      tracker: null,
      ai: null,
    };
    // Every lane — human or AI — runs its sequence through one SequenceTracker, so the
    // rules live only in input.js. (The AI used to keep its own inline copy of them.)
    lane.tracker = new SequenceTracker(p.layout ?? 1, {
      onImpulse: () => this.onSequenceComplete(lane),
      onJump: lane.human ? () => this.onJump(lane) : undefined,
      isGated: () => !this.remote && (this.phase === 'countdown' || this.phase === 'interstitial'),
      onGatedKey: () => applyFalseStart(lane.state),
    });
    if (!lane.human) {
      lane.ai = new AiTypist(this.options.difficulty ?? 'medium', (this.rng() * 2 ** 31) | 0);
    }
    return lane;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start() {
    const chars = [...new Set(this.lanes.map((l) => l.character))];
    this.setPhase('loading');
    await Promise.all(chars.map((c) => sprites.loadCharacter(c, MEET_ANIMS)));
    if (this.disposed) return;

    // Only HUMAN lanes listen to the keyboard — AI lanes carry a tracker too now, and
    // attaching theirs would let a player's keys drive the CPU runners.
    const humans = this.lanes.filter((l) => l.human && l.tracker);
    if (humans.length) this._detachKeys = attachKeyboard(humans.map((l) => l.tracker));

    // Touch pad: single-human modes only (1P local, online). Local 2P shares one
    // keyboard by design and demo has no player at all.
    if (isTouchDevice() && (this.remote || humans.length === 1)) {
      const layout = this.options.players?.find((p) => p.human)?.layout ?? 1;
      this._touchPad = new TouchPad(this.container, layout);
    }

    this.leg = 'sprint';
    this.setPhase('countdown');
    this.phaseClock = COUNTDOWN_SECONDS;

    let last = performance.now();
    let acc = 0;
    const frame = (now) => {
      if (this.disposed) return;
      acc += Math.min((now - last) / 1000, 0.25); // clamp tab-switch spikes
      last = now;
      while (acc >= FIXED_DT) {
        if (!this.remote) this.tick(FIXED_DT);
        else this.tickRemoteClock(FIXED_DT);
        acc -= FIXED_DT;
      }
      this.render(now);
      this.pushHud(now);
      this._raf = requestAnimationFrame(frame);
    };
    this._raf = requestAnimationFrame(frame);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this._raf);
    this._detachKeys?.();
    if (this._onRemoteKey) window.removeEventListener('keydown', this._onRemoteKey);
    this._touchPad?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
    sprites.unloadAll();
  }

  // ── Input events (human lanes) ────────────────────────────────────────

  onSequenceComplete(lane) {
    // Pre-gun presses never reach here — the tracker's gate turns each one into a false
    // start (see buildLane / SequenceTracker.injectKey).
    if (this.remote || this.phase !== 'racing') return;
    applyImpulse(lane.state);
  }

  onJump(lane) {
    if (this.remote || this.phase !== 'racing') return;
    startJump(lane.state);
  }

  // ── Local simulation ──────────────────────────────────────────────────

  setPhase(phase) {
    this.phase = phase;
    try { this.dotnet?.invokeMethodAsync('OnPhase', phase, this.leg ?? 'sprint'); } catch { /* page gone */ }
  }

  tick(dt) {
    switch (this.phase) {
      case 'countdown':
      case 'interstitial': {
        this.phaseClock -= dt;
        if (this.phaseClock <= 0) {
          if (this.phase === 'interstitial') {
            this.leg = 'hurdles';
            for (const l of this.lanes) { resetLane(l.state); l.tracker?.reset(); l.animTime = 0; }
          }
          this.setPhase('racing');
        }
        return;
      }
      case 'podium': {
        this.phaseClock -= dt;
        for (const l of this.lanes) l.animTime += dt;
        if (this.phaseClock <= 0 && this.mode === 'demo') this.restartMeet();
        return;
      }
      case 'racing': break;
      default: return;
    }

    const hurdles = this.leg === 'hurdles' ? HURDLE_POSITIONS : [];
    const legLength = this.leg === 'hurdles' ? CONSTANTS.HURDLES_LENGTH : CONSTANTS.SPRINT_LENGTH;

    for (const l of this.lanes) {
      if (l.ai && !l.state.finished) {
        l.ai.update(dt, {
          position: l.state.position,
          airborne: l.state.airborne,
          seqProgress: l.tracker.progress,
          onHurdlesLeg: this.leg === 'hurdles',
        }, {
          // Straight into the shared state machine: the AI faces exactly the rules a
          // human does, with no second implementation to drift.
          seqStep: (step) => l.tracker.injectKey(l.tracker.map.sequence[step]),
          jump: () => startJump(l.state),
        });
      }
      const events = tickLane(l.state, dt, hurdles, legLength);
      if (events.stumbled) l.animTime = 0;
      if (events.finished) {
        if (this.leg === 'sprint') l.sprintSeconds = l.state.legTime;
        else l.hurdlesSeconds = l.state.legTime;
      }
    }

    this.renderer.updateCamera(dt, this.lanes.map((l) => l.state), legLength);

    if (this.lanes.every((l) => l.state.finished)) {
      if (this.leg === 'sprint') {
        this.setPhase('interstitial');
        this.phaseClock = CONSTANTS.INTERSTITIAL_SECONDS;
        try { this.dotnet?.invokeMethodAsync('OnLegDone', 'sprint', this.lanes.map((l) => l.sprintSeconds)); } catch { }
      } else {
        this.finishMeet();
      }
    }
  }

  finishMeet() {
    const ranked = [...this.lanes].sort((a, b) =>
      (a.sprintSeconds + a.hurdlesSeconds) - (b.sprintSeconds + b.hurdlesSeconds) || a.index - b.index);
    ranked.forEach((l, i) => { l.placing = i + 1; });
    for (const l of this.lanes) l.animTime = 0;
    this.setPhase('podium');
    this.phaseClock = PODIUM_SECONDS;
    const results = this.lanes.map((l) => ({
      lane: l.index, name: l.name, character: l.character, human: l.human,
      sprintSeconds: l.sprintSeconds, hurdlesSeconds: l.hurdlesSeconds,
      totalSeconds: l.sprintSeconds + l.hurdlesSeconds, placing: l.placing,
    }));
    try { this.dotnet?.invokeMethodAsync('OnMeetDone', results); } catch { }
  }

  restartMeet() {
    this.leg = 'sprint';
    for (const l of this.lanes) {
      resetLane(l.state);
      l.tracker?.reset();
      l.sprintSeconds = -1; l.hurdlesSeconds = -1; l.placing = 0; l.animTime = 0;
    }
    this.renderer.cameraX = -6;
    this.setPhase('countdown');
    this.phaseClock = COUNTDOWN_SECONDS;
  }

  // ── Remote (online) mode — completed by the race-mode slice ──────────

  /**
   * Switch to server-driven rendering: local physics stops, snapshots rule.
   * Key presses are forwarded RAW to Blazor (OnRemoteKey) as layout ordinals —
   * the server sim owns the sequence rules, so the client must not interpret them.
   */
  enterRemoteMode(layout = 1) {
    this.remote = true;
    this.snapPrev = null;
    this.snapNext = null;
    this.snapClock = 0;
    const map = LAYOUTS[layout] ?? LAYOUTS[1];
    this._onRemoteKey = (e) => {
      if (e.repeat) return;
      if (e.code === map.jump) {
        e.preventDefault();
        try { this.dotnet?.invokeMethodAsync('OnRemoteKey', 'jump', 0); } catch { }
        return;
      }
      const step = map.sequence.indexOf(e.code);
      if (step < 0) return;
      e.preventDefault();
      try { this.dotnet?.invokeMethodAsync('OnRemoteKey', 'seq', step); } catch { }
    };
    window.addEventListener('keydown', this._onRemoteKey);
  }

  tickRemoteClock(dt) {
    this.snapClock += dt;
    for (const l of this.lanes) l.animTime += dt;
  }

  /** Feed a server snapshot (~15 Hz). Rendering interpolates between the last two. */
  applySnapshot(snapshot) {
    if (!this.remote) return;
    this.snapPrev = this.snapNext;
    this.snapNext = snapshot;
    this.snapClock = 0;
    const phase = snapshot.phase;
    this.leg = phase === 'hurdles' ? 'hurdles' : 'sprint';
    const mapped = phase === 'sprint' || phase === 'hurdles' ? 'racing' : phase;
    if (mapped !== this.phase) this.setPhase(mapped);
    for (const lane of snapshot.lanes) {
      const l = this.lanes[lane.lane];
      if (!l) continue;
      l.placing = lane.placing;
      l.sprintSeconds = lane.sprintSeconds;
      l.hurdlesSeconds = lane.hurdlesSeconds;
      if (lane.stumbling && l.currentAnim !== 'hitreact') l.animTime = 0;
    }
  }

  /** Interpolated lane states for rendering in remote mode. */
  remoteLaneStates() {
    const next = this.snapNext;
    if (!next) return this.lanes.map(() => ({ position: 0, speed: 0, airborne: 0, stumbling: 0, finished: false }));
    const prev = this.snapPrev ?? next;
    // 15 Hz broadcast → interpolate across ~66 ms.
    const t = Math.min(this.snapClock / (1 / 15), 1);
    return next.lanes.map((n) => {
      const p = prev.lanes[n.lane] ?? n;
      return {
        position: p.position + (n.position - p.position) * t,
        speed: n.speed,
        airborne: n.airborne ? 1 : 0,
        stumbling: n.stumbling ? 1 : 0,
        finished: n.finished,
      };
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  pickAnim(l, s) {
    if (this.phase === 'podium') return l.placing === this.lanes.length && this.lanes.length > 1 ? 'idle' : 'dance';
    // Waiting to race — between legs, in the countdown, or already across the line while
    // the rest of the field comes in. tickLane freezes a finished lane's speed at its
    // crossing value and resetLane only runs when the next leg starts, so without this
    // the speed-based picks below would keep the run cycle going on a standing runner.
    if (this.phase !== 'racing' || s.finished) return 'idle';
    if (s.stumbling > 0) return 'hitreact';
    if (s.airborne > 0) return 'jump';
    if (s.speed > 3) return 'run';
    if (s.speed > 0.3) return 'walk';
    return 'idle';
  }

  render(now) {
    const laneCount = this.lanes.length || 4;
    const states = this.remote
      ? this.remoteLaneStates()
      : this.lanes.map((l) => l.state);

    if (this.remote) {
      const legLength = this.leg === 'hurdles' ? CONSTANTS.HURDLES_LENGTH : CONSTANTS.SPRINT_LENGTH;
      this.renderer.updateCamera(FIXED_DT, states, legLength);
    }

    this.renderer.drawScene(this.leg === 'hurdles' ? 'hurdles' : 'sprint', laneCount);

    const dt = 1 / 60;
    this.lanes.forEach((l, i) => {
      const s = states[i];
      const anim = this.pickAnim(l, s);
      if (anim !== l.currentAnim) { l.currentAnim = anim; l.animTime = 0; }
      else if (!this.remote) l.animTime += dt;

      const x = this.renderer.toX(s.position);
      const y = this.renderer.laneY(i, laneCount);
      const h = this.renderer.spriteHeight(i, laneCount);
      // Airborne lift: a simple arc peaking mid-jump.
      const jumpT = s.airborne > 0 ? 1 - s.airborne / CONSTANTS.JUMP_DURATION : 0;
      const lift = jumpT > 0 ? Math.sin(jumpT * Math.PI) * h * 0.45 : 0;
      sprites.draw(this.renderer.ctx, l.character, anim, l.animTime, x, y - lift, h,
        { loop: anim !== 'jump' && anim !== 'hitreact' });
    });

    this.drawOverlay();
  }

  drawOverlay() {
    const { ctx } = this.renderer;
    const w = this.renderer.viewW; const h = this.renderer.viewH;
    if (this.phase === 'countdown' || this.phase === 'interstitial') {
      const n = Math.ceil(this.phaseClock);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = `800 ${h * 0.18}px system-ui, sans-serif`;
      ctx.fillText(this.phase === 'countdown' ? `${n}` : `Hurdles in ${n}`, w / 2, h / 2);
      if (this.phase === 'countdown') {
        ctx.font = `600 ${h * 0.045}px system-ui, sans-serif`;
        ctx.fillText('Type your keys IN ORDER to run', w / 2, h * 0.62);
      }
    }
  }

  // ── HUD ───────────────────────────────────────────────────────────────

  pushHud(now) {
    // Local modes only. Online, the page drives its HUD straight from the server snapshot
    // (which knows WHICH lane is yours); pushing lanes in snapshot order made a second
    // writer that mapped lane 0 onto the local player's HUD row and fought the first one.
    if (this.remote) return;
    if (now - this.lastHudAt < HUD_THROTTLE_MS) return;
    this.lastHudAt = now;
    const hud = {
      phase: this.phase,
      leg: this.leg ?? 'sprint',
      clock: this.phase === 'racing'
        ? Math.max(0, ...this.lanes.map((l) => l.state.legTime))
        : this.phaseClock,
      lanes: this.lanes.map((l) => ({
        position: l.state.position,
        speed: l.state.speed,
        seqProgress: l.tracker?.progress ?? 0,
        legTime: l.state.legTime,
        finished: l.state.finished,
      })),
    };
    try { this.dotnet?.invokeMethodAsync('OnHud', hud); } catch { /* page gone */ }
  }
}
