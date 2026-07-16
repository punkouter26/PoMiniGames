// game.js — orchestration: phase machine, scoring, the rAF loop, and C# callbacks.
import { createScene } from './scene.js';
import { createWorld, stepWorld } from './physics.js';
import { generateTrack } from './track.js';
import { createMarbles } from './marbles.js';
import { createAudio } from './audio.js';

const RESULT_MS = 3200;     // how long the result banner shows before next track
const RACE_TIMEOUT = 160;   // s — failsafe for the lengthened (1800-unit) chute + friction bands
const TICK_INTERVAL = 0.12; // s — throttle for OnRaceTick to C#
const BEST_KEY = 'pomarblerace_best';

export class Game {
  constructor(containerId, dotnetRef, demo) {
    this.container = document.getElementById(containerId);
    this.dotnet = dotnetRef || null;
    this.demo = !!demo;
    this.scene = createScene(this.container);
    const w = createWorld();
    this.world = w.world;
    this.materials = w.materials;
    this.audio = createAudio();

    this.phase = 'pick';
    this.score = 0;
    this.best = parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0;
    this.chosen = -1;
    // Date.parse(new Date().toString()) round-trips through a second-precision string, so two
    // loads in the same second raced the identical track. Use the raw epoch ms.
    this.seed = ((Date.now() & 0xffffff) ^ 0x9e3779) >>> 0;
    this.track = null;
    this.marbleSet = null;
    this.raceClock = 0;
    this.tickAccum = 0;
    this.resultTimer = 0;
    this.disposed = false;
    this._raf = 0;
    this._lastTs = 0;

    this._buildTrack();
    this._bindKeys();
  }

  // ── public API (called from index.js / interop) ──
  start() {
    this.audio.resume();
    this._lastTs = 0;
    const loop = (ts) => {
      if (this.disposed) return;
      const now = ts || performance.now();
      const dt = this._lastTs ? (now - this._lastTs) / 1000 : 0.016;
      this._lastTs = now;
      this._frame(Math.min(dt, 0.05));
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
    if (this.demo) this._autoPickSoon();
  }

  pick(index) {
    if (this.phase !== 'pick') return;
    if (index < 0 || index > 7) return;
    this.chosen = index;
    this.marbleSet.highlight(index);
    this._setPhase('racing');
    this.raceClock = 0;
    this.tickAccum = TICK_INTERVAL;
    this.scene.followTarget(this.marbleSet.marbles[index].mesh.position, 0, true);
    this.scene.punchFov();   // #10 — a quick FOV widen as the race kicks off
    this.audio.resume();
  }

  regenerate() {
    if (this.phase === 'racing') return; // ignore mid-race spam; R is for pick/result
    this._nextTrack();
  }

  setMuted(m) { this.audio.setMuted(m); }

  dispose() {
    this.disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._unbindKeys();
    if (this.marbleSet) this.marbleSet.dispose();
    if (this.track) this.track.dispose();
    this.audio.dispose();
    this.scene.dispose();
  }

  // ── internals ──
  _buildTrack() {
    this._podiumSent = false; // reset the top-3 podium for the new race
    this.track = generateTrack(this.world, this.materials, this.seed >>> 0);
    this.scene.add(this.track.group);
    this.marbleSet = createMarbles(this.world, this.materials, this.track.startPositions, -1,
      (v, pos, color) => {
        // Only BIG collisions make a sound — the constant clinking from every
        // little tap was too noisy. Sparks still fire on the smaller hits.
        if (v > 8) this.audio.playClink(v);
        this.scene.burstSparks(pos, color, Math.min(14, 4 + Math.floor(v)), Math.min(1.6, 0.5 + v * 0.12));
      });
    for (const m of this.marbleSet.marbles) this.scene.add(m.mesh);
    this.scene.add(this.marbleSet.decorations);
    this.chosen = -1;
    this._setPhase('pick');
    // frame the start gate from above
    const ov = this.track.overviewTarget;
    this.scene.followTarget(ov, 0, true);
  }

  _setPhase(p) {
    this.phase = p;
    this._invoke('OnPhase', p, this.chosen, this.score, this.best);
  }

  _nextTrack() {
    if (this.marbleSet) { for (const m of this.marbleSet.marbles) this.scene.remove(m.mesh); this.scene.remove(this.marbleSet.decorations); this.marbleSet.dispose(); }
    if (this.track) { this.scene.remove(this.track.group); this.track.dispose(); }
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    this._buildTrack();
    if (this.demo) this._autoPickSoon();
  }

  _autoPickSoon() {
    // pick a random marble after a short beat so the start gate is visible first
    this._demoPickAt = performance.now() + 1200;
  }

  // Which marble the camera centers on. Demo/spectator view tracks the current
  // race LEADER (front-runner) so the front of the pack stays framed; a real
  // player's camera stays on their own picked marble.
  _focusMarble() {
    const leader = this.marbleSet.leaderboard()[0];
    if (this.demo) return leader;
    const me = this.marbleSet.marbles[this.chosen];
    return (me && !me.eliminated) ? me : leader;
  }

  _frame(dt) {
    // demo auto-pick
    if (this.demo && this.phase === 'pick' && this._demoPickAt && performance.now() >= this._demoPickAt) {
      this._demoPickAt = 0;
      this.pick(Math.floor(Math.random() * 8));
    }

    if (this.phase === 'racing') {
      stepWorld(this.world, dt);
      this.marbleSet.sync();
      for (const t of this.track.turnstiles) { t.mesh.position.copy(t.body.position); t.mesh.quaternion.copy(t.body.quaternion); }

      // Remove any marble that has fallen out of bounds (dropped well below the
      // track surface at its position) — it's out of the race.
      for (const m of this.marbleSet.marbles) {
        if (m.finished || m.eliminated) continue;
        if (m.body.position.y < this.track.floorY(m.body.position.z) - 30) {
          this.marbleSet.eliminate(m);
        }
      }

      this.raceClock += dt;
      const { allDone, justFinished } = this.marbleSet.checkFinishes(this.track.finishZ, this.raceClock);
      for (const m of justFinished) {
        this.scene.burstConfetti(m.mesh.position);   // celebrate each ball crossing the line
        this.audio.playClink(6);                      // finish chime
      }
      // Podium: the moment the 3rd marble crosses, freeze the top-3 (winner + 2)
      // with their gaps behind the winner and push it to the HUD overlay.
      if (!this._podiumSent && this.marbleSet.marbles.filter((m) => m.finished).length >= 3) {
        this._podiumSent = true;
        this._sendPodium();
      }
      if (allDone || this.raceClock >= RACE_TIMEOUT) {
        if (!allDone) this.marbleSet.forceFinishRemaining(this.raceClock);
        this._resolve();
      }

      // Camera centers the focus marble: the race LEADER in demo/spectator mode,
      // or the player's own pick in a real game.
      const focus = this._focusMarble();
      if (focus) this.scene.followTarget(focus.mesh.position, dt, false);

      this.tickAccum += dt;
      if (this.tickAccum >= TICK_INTERVAL) { this.tickAccum = 0; this._sendTick(); }
    } else if (this.phase === 'result') {
      // keep turnstiles/marbles visually settled; advance after the banner
      this.marbleSet.sync();
      this.resultTimer -= dt;
      const focus = this._focusMarble();
      if (focus) this.scene.followTarget(focus.mesh.position, dt, false);
      if (this.resultTimer <= 0) this._nextTrack();
    } else {
      // pick phase: gentle overview of the start gate
      this.scene.followTarget(this.track.overviewTarget, dt, false);
    }

    this.scene.render();
  }

  _resolve() {
    this.marbleSet.leaderboard();   // final standings — assigns place to every marble still racing
    const me = this.marbleSet.marbles[this.chosen];
    // A marble that fell off the track has no placing: it neither finished nor holds a rank.
    // Reporting its last-known place scored the player a point for being eliminated, and an
    // elimination before the first standings pass left place at -1, which `place <= 3` also
    // counted as a win.
    const finished = !!me && me.finished && !me.eliminated;
    const place = finished ? me.place : -1;
    const won = finished && place >= 1 && place <= 3;
    if (won) this.score += 1;
    if (this.score > this.best) { this.best = this.score; try { localStorage.setItem(BEST_KEY, String(this.best)); } catch { } }

    this.resultTimer = RESULT_MS / 1000;
    this._setPhase('result');
    this.audio.playSting(won);
    this._sendTick(); // final standings
    this._invoke('OnRaceResult', won, place, this.score);
  }

  // C# is handed parallel primitive arrays rather than a JSON string: the string form was
  // serialized by us, serialized again by the interop layer, then parsed a third time on the
  // C# side — every 0.12s for a whole race. Colours are omitted entirely; C# derives them from
  // the marble index (its Colors array mirrors MARBLE_COLORS).
  _invoke(method, ...args) {
    if (!this.dotnet) return;
    // invokeMethodAsync rejects asynchronously, so a bare try/catch here would never see the
    // failure — it has to be caught on the promise.
    try {
      const p = this.dotnet.invokeMethodAsync(method, ...args);
      if (p && p.catch) p.catch(() => { });
    } catch { }
  }

  _sendPodium() {
    if (!this.dotnet) return;
    const top3 = this.marbleSet.marbles
      .filter((m) => m.finished)
      .sort((a, b) => a.finishOrder - b.finishOrder)
      .slice(0, 3);
    const winTime = top3.length ? top3[0].finishTime : 0;
    const round2 = (v) => Math.round(v * 100) / 100;
    this._invoke('OnPodium',
      top3.map((m) => m.index),
      top3.map((m) => round2(m.finishTime)),
      top3.map((m) => round2(m.finishTime - winTime)));
  }

  _sendTick() {
    if (!this.dotnet) return;
    const order = this.marbleSet.leaderboard();
    this._invoke('OnRaceTick',
      order.map((m) => m.index),
      order.map((m) => Math.round(m.speed * 10) / 10),
      order.map((m) => m.finished),
      order.map((m) => (m.finished ? Math.round(m.finishTime * 100) / 100 : 0)),
      this.marbleSet.progress());
  }

  _bindKeys() {
    this._keyHandler = (e) => {
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); this.regenerate(); }
      // M was documented as the mute key but was never actually bound to anything, and the
      // only other caller (a Settings drawer) had been deleted — so mute was unreachable.
      if (e.key === 'm' || e.key === 'M') { e.preventDefault(); this.audio.toggleMuted(); }
    };
    window.addEventListener('keydown', this._keyHandler);
  }
  _unbindKeys() { if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler); }
}
