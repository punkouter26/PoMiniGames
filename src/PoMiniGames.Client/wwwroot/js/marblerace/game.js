// game.js — orchestration: phase machine, scoring, the camera director, the rAF loop,
// and C# callbacks.
import { createScene } from './scene.js';
import { createWorld, stepWorld } from './physics.js';
import { generateTrack } from './track.js';
import { createMarbles, MARBLE_COUNT } from './marbles.js';
import { createAudio } from './audio.js';

const RESULT_MS = 3600;     // how long the result banner shows before next track
const RACE_TIMEOUT = 180;   // s — failsafe for the lengthened chute + friction bands + Gauntlet
const TICK_INTERVAL = 0.1;  // s — throttle for OnRaceTick to C#
const BEST_KEY = 'pomarblerace_best';
const LB_SHOWN = 6;         // leaderboard rows sent to the HUD (top N of the 101-marble field)

// ── The player's verb ──
// Continuous lateral steering. Holding left/right adds sideways acceleration to the picked
// marble for as long as it's held — this is the entire interactive surface of the game, so
// the player is always able to fight for the boost-pad line or steer off a Gauntlet rotor.
// The force is divided by mass, so the roster's heavyweights are genuinely harder to steer:
// the trade for the momentum they carry through the Gauntlet.
const STEER_ACCEL = 72;      // lateral units/s² — raised with gravity so steering keeps its bite

// ── Boost pads ──
const BOOST_ACCEL = 40;      // units/s² along the track tangent while on a pad
const BOOST_MAX_SPEED = 150; // don't let a marble that camps a pad accelerate without bound

// ── Kickers (#6) ── telegraphed push-only band that fires on a cycle, shoving marbles sideways.
const KICK_DV = 16;          // lateral velocity punch at mass 1 when it fires (÷ mass — heavies resist)
const KICK_UP = 4;           // small upward pop so the kick reads as a jolt, not a slide
const KICK_CHARGE = 0.34;    // fraction of each cycle spent visibly charging up — the TELL

// ── Scoring ──
// Placement-weighted across the 101-marble field: finishing anywhere in the top SCORE_TOP
// scores, more for a higher place, with a dominant-win bonus and a streak multiplier on top.
// Beating 100 marbles with only a steering input makes even a top-10 a real result, so the
// scoring bar is the top 10 rather than a podium of 3.
const SCORE_TOP = 10;                // finish in the top 10 of 101 to score / keep a streak
const DOMINANT_GAP = 1.5;            // s clear of 2nd for the dominant-win bonus
const DOMINANT_BONUS = 4;
const MAX_STREAK_STEPS = 4;          // multiplier caps at 1 + 4*0.5 = 3×

// ── Director ──
// The camera locks to the player's own marble (this is a game you steer, so you must always
// see what you're steering); the leader only takes the shot when the player is out of the
// race or during the slow-motion finish. See _pickShot.
const SLOWMO_DIST = 45;       // units from the finish where the leader triggers slow-motion
const SLOWMO_SCALE = 0.35;

// How far under the track centerline a marble may legitimately be before it counts as
// having fallen off. Sized against the banked inner edge of the wide road — see the
// out-of-bounds check in _frame. Raised with gravity: faster, weightier marbles ride the
// banks higher, so a tighter margin would eliminate them for taking the outside line.
const OOB_MARGIN = 58;

// Ceiling on a reported time gap; beyond this the HUD shows "+60s" rather than a number
// whose precision it hasn't earned. See _gapSeconds.
const GAP_MAX = 60;

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
    this.streak = 0;
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

    // player verb — lateral steering, held via keyboard or the on-screen pads
    this._steerLeft = false;
    this._steerRight = false;
    this._steerSparkAccum = 0;
    this._wasBoosting = false;

    // director
    this.shotReason = 'LEADER';
    this.slowmo = false;
    this._lastFocus = null;

    this._buildTrack();
    this._bindKeys();
  }

  // ── public API (called from index.js / interop) ──
  start() {
    this.audio.resume();
    this._lastTs = 0;
    this._paused = true; // 2026-07-19: gate the rAF loop on resume() so the
                         // engine can't run the pick countdown and racing
                         // phase while the intro modal is still up.
    const loop = (ts) => {
      if (this.disposed) return;
      const now = ts || performance.now();
      const dt = this._lastTs ? (now - this._lastTs) / 1000 : 0.016;
      this._lastTs = now;
      if (!this._paused) this._frame(Math.min(dt, 0.05));
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
    // Demo mode is auto-cycled by the kiosk; it gets the same pause gate
    // (the intro card flashes for DemoDelayMs then calls resume()).
    if (this.demo) this._autoPickSoon();
  }

  // 2026-07-19 browser audit #1: the engine used to call _setPhase('pick')
  // during construction and immediately start a 3s auto-pick, all while
  // the intro modal was still on screen. resume() is the explicit
  // acknowledgment from the host that the intro is dismissed and the
  // engine may now run the pick phase (and the rAF tick).
  resume() {
    if (this._paused) {
      this._paused = false;
      this._lastTs = 0; // discard the dt we accumulated while paused
      // Re-emit the current phase so the host can sync its overlay state.
      this._invoke('OnPhase', this.phase, this.chosen, this.score, this.best, this.streak);
    }
  }

  pick(index) {
    if (this.phase !== 'pick') return;
    if (index < 0 || index >= MARBLE_COUNT) return;
    this.chosen = index;
    this.marbleSet.highlight(index);
    this._steerLeft = this._steerRight = false;
    this._setPhase('racing');
    this.raceClock = 0;
    this.tickAccum = TICK_INTERVAL;
    for (const m of this.marbleSet.marbles) m.prevPlace = -1;
    this.scene.followTarget(this.marbleSet.marbles[index].mesh.position, 0, true);
    this.scene.punchFov();   // a quick FOV widen as the race kicks off
    this.audio.resume();
    this.audio.playGun();
  }

  // The player's in-race input: hold a direction to steer the picked marble sideways. dir is
  // -1 (left) or +1 (right); active toggles the hold. Keyboard drives this on keydown/keyup,
  // the on-screen pads on pointer down/up. The force itself is applied every physics step in
  // _applySteer — this just records which way, if any, is currently held.
  setSteer(dir, active) {
    if (dir < 0) this._steerLeft = !!active;
    else if (dir > 0) this._steerRight = !!active;
  }

  // Applied once per physics step while racing. Left+right held cancel out. The push is along
  // the track's LOCAL right vector, so it stays intuitive through banked turns and hairpins
  // where world-space X would flip under the player.
  _applySteer(sdt) {
    if (this.demo || this.phase !== 'racing') return;
    const dir = (this._steerRight ? 1 : 0) - (this._steerLeft ? 1 : 0);
    if (!dir) return;
    const m = this.marbleSet.marbles[this.chosen];
    if (!m || m.finished || m.eliminated) return;

    const rb = this.track.rightAt(m.body.position.z);
    // A lateral acceleration (÷ mass so it's independent of the mass unit), applied along the
    // track's local right vector.
    const dv = (STEER_ACCEL / m.body.mass) * dir * sdt;
    m.body.velocity.x += rb.x * dv;
    m.body.velocity.y += rb.y * dv;
    m.body.velocity.z += rb.z * dv;

    // Throttled sparks off the steered marble — feedback that the input is landing, without
    // the every-frame audio a held key would otherwise spam.
    this._steerSparkAccum += sdt;
    if (this._steerSparkAccum >= 0.08) {
      this._steerSparkAccum = 0;
      this.scene.burstSparks(m.mesh.position, m.spec.color, 3, 0.7);
    }
  }

  regenerate() {
    if (this.phase === 'racing') return; // ignore mid-race spam; R is for pick/result
    this._nextTrack();
  }

  setMuted(m) { this.audio.setMuted(m); }

  beep(final) { this.audio.playBeep(!!final); }

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
    this.track = generateTrack(this.world, this.materials, this.seed >>> 0, MARBLE_COUNT);
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
    this.slowmo = false;
    this._setPhase('pick');
    // frame the start gate from above
    const ov = this.track.overviewTarget;
    this.scene.followTarget(ov, 0, true);
  }

  _setPhase(p) {
    this.phase = p;
    // 2026-07-19 browser audit #1: skip phase notifications while the
    // intro is up. The host can't react to OnPhase('pick') until resume()
    // fires anyway, and a notify during intro would race the host's
    // StartPickCountdown. The constructor's first _setPhase('pick') is
    // simply held until resume() flushes it.
    if (this._paused) return;
    this._invoke('OnPhase', p, this.chosen, this.score, this.best, this.streak);
  }

  _nextTrack() {
    if (this.marbleSet) { for (const m of this.marbleSet.marbles) this.scene.remove(m.mesh); this.scene.remove(this.marbleSet.decorations); this.marbleSet.dispose(); }
    if (this.track) { this.scene.remove(this.track.group); this.track.dispose(); }
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    this._buildTrack();
    if (this.demo) this._autoPickSoon();
  }

  _autoPickSoon() {
    // demo mode: assign the red marble after a short beat so the start gate is visible first
    // (the demo camera follows the leader regardless — chosen just needs to be valid).
    this._demoPickAt = performance.now() + 1200;
  }

  // ── Camera director ──
  // This is a game you steer, so the camera stays LOCKED to your own marble the whole race —
  // you must always see the marble you're controlling. The only times it leaves you: when
  // you're out of the race (eliminated/finished → follow the leader so there's still a race to
  // watch), and the slow-motion finish (the leader's money shot — unless YOU are that leader,
  // in which case staying on you already frames it).
  _pickShot() {
    const leader = this.marbleSet.leaderboard()[0];
    const take = (marble, reason) => { this.shotReason = reason; return marble; };
    if (this.demo) return take(leader, 'LEADER');

    const me = this.marbleSet.marbles[this.chosen];
    const meAlive = me && !me.eliminated && !me.finished;
    // 1-player: stay LOCKED to your own marble the entire race — including the
    // slow-mo finish. You must always see the marble you're steering. The camera
    // only leaves you once you're out of the race (eliminated or finished), when
    // it falls back to the leader so there's still a race to watch.
    if (!meAlive) return take(leader, 'LEADER');

    return take(me, me === leader ? 'LEADER' : 'YOU');
  }

  // Time gap behind the leader, in seconds. Finished marbles compare finish times; those
  // still running get the standard racing estimate (distance behind ÷ own speed), which is
  // what a viewer actually wants to know — "how long until I'm there".
  // Capped: the estimate divides by the marble's own speed, so a slow one coming out of a
  // rumble band reported "+232.0s" — arithmetically fine, useless as a readout. Past
  // GAP_MAX the only information left is "out of it", so say that instead of a number.
  _gapSeconds(m, leader) {
    if (!leader || m === leader) return 0;
    if (m.finished && leader.finished) return Math.max(0, m.finishTime - leader.finishTime);
    const dz = leader.body.position.z - m.body.position.z;
    if (dz <= 0) return 0;
    return Math.min(GAP_MAX, dz / Math.max(4, m.speed));
  }

  _applyBoost(sdt) {
    const me = this.chosen >= 0 ? this.marbleSet.marbles[this.chosen] : null;
    let playerBoosting = false;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      if (!this.track.inBoost(m.body.position.z)) continue;
      const v = m.body.velocity;
      if (v.length() < BOOST_MAX_SPEED) {
        const d = this.track.dirAt(m.body.position.z);
        v.x += d.x * BOOST_ACCEL * sdt;
        v.y += d.y * BOOST_ACCEL * sdt;
        v.z += d.z * BOOST_ACCEL * sdt;
      }
      if (m === me) playerBoosting = true;
      if (Math.random() < 0.25) this.scene.burstSparks(m.mesh.position, 0x22d3ee, 2, 0.5);
    }
    // Edge-trigger the whoosh so it fires once per pad, not every frame you're on one.
    if (playerBoosting && !this._wasBoosting) this.audio.playWhoosh();
    this._wasBoosting = playerBoosting;
  }

  // #6 Kickers: drive the telegraph (brightening pad) and the fire moment. Push-only, so it
  // can scatter the pack and force a steering correction but never trap a marble.
  _applyKickers() {
    const kickers = this.track.kickers;
    if (!kickers) return;
    const t = this.raceClock;
    for (const k of kickers) {
      const phase = (t % k.period) / k.period;         // 0..1 within the charge→fire cycle
      // Tell: brighten over the last KICK_CHARGE of the cycle, easing in so it "winds up".
      const charge = phase > (1 - KICK_CHARGE) ? (phase - (1 - KICK_CHARGE)) / KICK_CHARGE : 0;
      k.mat.emissiveIntensity = 0.5 + charge * charge * 2.4;
      // Fire on the wrap, when phase resets from near-1 back toward 0.
      if (phase < k._lastPhase) this._fireKicker(k);
      k._lastPhase = phase;
    }
  }

  _fireKicker(k) {
    const [a, b] = k.band;
    const len = this.track.length;
    let hits = 0;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      const s = m.body.position.z / len;
      if (s < a || s > b) continue;
      const rb = this.track.rightAt(m.body.position.z);
      // Alternate the kick direction by marble index so a fire splits the pack rather than
      // shoving everyone the same way — and the player has to steer back to their line.
      const dv = (KICK_DV / m.body.mass) * (m.index % 2 === 0 ? 1 : -1);
      m.body.velocity.x += rb.x * dv;
      m.body.velocity.y += rb.y * dv + KICK_UP;
      m.body.velocity.z += rb.z * dv;
      this.scene.burstSparks(m.mesh.position, 0xe879f9, 14, 1.5);
      hits++;
    }
    k.mat.emissiveIntensity = 3.6;          // bright flash on fire (visible even when it hits nothing)
    if (hits > 0) this.audio.playWhoosh();  // ...but only make noise when it actually connects
  }

  _frame(dt) {
    // demo auto-pick
    if (this.demo && this.phase === 'pick' && this._demoPickAt && performance.now() >= this._demoPickAt) {
      this._demoPickAt = 0;
      this.pick(Math.floor(Math.random() * MARBLE_COUNT));
    }

    if (this.phase === 'racing') {
      const lbPre = this.marbleSet.leaderboard();
      const leaderPre = lbPre[0];
      // Slow-motion as the leader runs at the line. sdt scales the simulation, so finish
      // times stay measured in simulation seconds and remain comparable across races.
      this.slowmo = !!leaderPre && !leaderPre.finished &&
        (this.track.finishZ - leaderPre.body.position.z) < SLOWMO_DIST;
      const sdt = this.slowmo ? dt * SLOWMO_SCALE : dt;

      this.track.driveMotors();
      this._applyBoost(sdt);
      this._applySteer(sdt);   // player's held steering, integrated by the step below
      this._applyKickers();    // #6 telegraphed kicker band (push-only)
      stepWorld(this.world, sdt);
      this.marbleSet.sync();
      for (const t of this.track.turnstiles) { t.mesh.position.copy(t.body.position); t.mesh.quaternion.copy(t.body.quaternion); }

      this.raceClock += sdt;
      // Finishes are resolved BEFORE the out-of-bounds sweep. Crossing the line is terminal:
      // a marble that has already finished is frozen and can't fall, and one that crosses and
      // drops in the same step has still finished. Sweeping first meant a marble past the
      // line could be scored as eliminated instead of a finisher (seen headless: Sprout
      // eliminated at z=1863 with the line at z=1791).
      const { justFinished } = this.marbleSet.checkFinishes(this.track.finishZ, this.raceClock);

      // Remove any marble that has fallen out of bounds (dropped well below the
      // track surface at its position) — it's out of the race.
      //
      // floorY() is the CENTERLINE height, and the margin has to clear how far below it a
      // marble can legitimately sit. On a 64-wide road banked to 0.6 rad the inner edge is
      // ~18 units under the centerline, plus ~10 of vertical undulation — the old 30-unit
      // margin would have eliminated marbles for the crime of taking the inside line.
      for (const m of this.marbleSet.marbles) {
        if (m.finished || m.eliminated) continue;
        if (m.body.position.y < this.track.floorY(m.body.position.z) - OOB_MARGIN) {
          this.marbleSet.eliminate(m);
        }
      }

      // Recomputed after the sweep rather than taken from checkFinishes: a marble eliminated
      // just above is out of the race too, and the race ends once nothing is still running.
      const allDone = this.marbleSet.marbles.every((m) => m.finished || m.eliminated);

      for (const m of justFinished) {
        this.scene.burstConfetti(m.mesh.position);   // celebrate each ball crossing the line
        this.audio.playFinish();
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

      // Audio beds ride the focused marble's speed and how close the race is to resolving.
      // #10: tightened the range (400→300) and eased it (pow 0.6) so the bed ramps up harder
      // and sooner as the leader runs at the line — the music leans into the finish.
      const leaderNow = this.marbleSet.leaderboard()[0];
      const nearRaw = leaderNow
        ? 1 - Math.max(0, Math.min(1, (this.track.finishZ - leaderNow.body.position.z) / 300))
        : 0;
      const nearFinish = Math.pow(nearRaw, 0.6);
      this.audio.updateBeds(leaderNow ? leaderNow.speed : 0, nearFinish, this.phase === 'racing');

      // Snap on a shot change rather than lerping across the track: a director's cut is a
      // cut. Lerping between two marbles 200 units apart reads as the camera losing the race.
      const focus = this._pickShot();
      if (focus) {
        // Feed the camera the marble's heading (so it looks along the track ahead, #2) and
        // speed (so the FOV widens with pace, #4).
        const fwd = this.track.dirAt(focus.body.position.z);
        this.scene.followTarget(focus.mesh.position, dt, focus !== this._lastFocus, fwd, focus.speed);
        this.marbleSet.setCameraFocus(focus.index);
        this._lastFocus = focus;
      }

      this.tickAccum += dt;
      if (this.tickAccum >= TICK_INTERVAL) { this.tickAccum = 0; this._sendTick(); }
    } else if (this.phase === 'result') {
      // keep turnstiles/marbles visually settled; advance after the banner
      this.marbleSet.sync();
      this.resultTimer -= dt;
      const winner = this.marbleSet.leaderboard()[0];
      if (winner) this.scene.followTarget(winner.mesh.position, dt, false);
      if (this.resultTimer <= 0) this._nextTrack();
    } else {
      // pick phase: gentle overview of the start gate
      this.scene.followTarget(this.track.overviewTarget, dt, false);
    }

    this.scene.render();
  }

  _resolve() {
    this.audio.silenceBeds();
    const order = this.marbleSet.leaderboard();   // final standings — assigns place to every marble
    const me = this.marbleSet.marbles[this.chosen];
    // A marble that fell off the track has no placing: it neither finished nor holds a rank.
    // Reporting its last-known place scored the player a point for being eliminated, and an
    // elimination before the first standings pass left place at -1, which `place <= 3` also
    // counted as a win.
    const finished = !!me && me.finished && !me.eliminated;
    const place = finished ? me.place : -1;
    // Score for finishing anywhere in the top SCORE_TOP of the 101-marble field.
    const won = finished && place >= 1 && place <= SCORE_TOP;

    let gained = 0;
    if (won) {
      // Higher place = more points: 1st is worth SCORE_TOP, SCORE_TOP-th is worth 1.
      let base = SCORE_TOP - place + 1;
      // A dominant win — 1st and clear of 2nd by DOMINANT_GAP — is worth more again. This is
      // where finish TIME enters the score.
      if (place === 1 && order.length > 1 && order[1].finished &&
          (order[1].finishTime - me.finishTime) >= DOMINANT_GAP) {
        base += DOMINANT_BONUS;
      }
      this.streak += 1;
      const mult = 1 + Math.min(this.streak - 1, MAX_STREAK_STEPS) * 0.5;
      gained = Math.round(base * mult);
      this.score += gained;
    } else {
      // The run ends. A miss (finishing outside the top SCORE_TOP, or falling off) costs the
      // whole run — that's the stake that makes a streak worth watching.
      this.streak = 0;
      this.score = 0;
    }
    if (this.score > this.best) { this.best = this.score; try { localStorage.setItem(BEST_KEY, String(this.best)); } catch { } }

    this.resultTimer = RESULT_MS / 1000;
    this._setPhase('result');
    this.audio.playSting(won);
    this._sendTick(); // final standings
    this._invoke('OnRaceResult', won, place, this.score, gained, this.streak, this.best);
  }

  // C# is handed parallel primitive arrays rather than a JSON string: the string form was
  // serialized by us, serialized again by the interop layer, then parsed a third time on the
  // C# side — every tick for a whole race. Colours/names are omitted; C# derives them from the
  // marble index (index 0 = the red player, everything else blue).
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
    const leader = order[0];
    const me = this.chosen >= 0 ? this.marbleSet.marbles[this.chosen] : null;

    // Overtake cue: compare the player's place against the last tick's before the snapshot
    // below overwrites it. Only the player's own position changes are worth a sound.
    if (me && !me.eliminated && this.phase === 'racing' && me.prevPlace > 0 && me.place !== me.prevPlace) {
      this.audio.playOvertake(me.place < me.prevPlace);
    }
    for (const m of order) m.prevPlace = m.place;

    // #3 lateral position of the player's marble across the channel (−1 left edge … +1 right
    // edge), for the HUD edge gauge. 0 when the player has no live marble.
    const myLateral = (me && !me.eliminated) ? this.track.lateralOf(me.body.position) : 0;

    // With 101 marbles the HUD can't render the whole field, so only the top LB_SHOWN are sent
    // for the leaderboard list. The player's own standing is sent separately (place / field /
    // gap) and shown in the telemetry panel, so it's always visible even when far down the pack.
    const shown = order.slice(0, LB_SHOWN);
    const myLive = !!me && !me.eliminated;
    const round2 = (v) => Math.round(v * 100) / 100;
    this._invoke('OnRaceTick',
      shown.map((m) => m.index),
      shown.map((m) => Math.round(m.speed * 10) / 10),
      shown.map((m) => m.finished),
      shown.map((m) => (m.finished ? round2(m.finishTime) : 0)),
      shown.map((m) => round2(this._gapSeconds(m, leader))),
      this.marbleSet.progress(),
      myLive ? this.marbleSet.progressOf(me) : 0,
      round2(this.raceClock),
      Math.round(myLateral * 1000) / 1000,
      myLive ? me.place : -1,                                  // player's absolute place
      order.length,                                            // field size (marbles still racing)
      myLive ? round2(this._gapSeconds(me, leader)) : 0,       // player's gap to the leader
      this.streak,
      this._lastFocus ? this._lastFocus.index : -1,
      this.shotReason || 'LEADER');
  }

  _bindKeys() {
    this._keyHandler = (e) => {
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); this.regenerate(); }
      // M was documented as the mute key but was never actually bound to anything, and the
      // only other caller (a Settings drawer) had been deleted — so mute was unreachable.
      if (e.key === 'm' || e.key === 'M') { e.preventDefault(); this.audio.toggleMuted(); }
      // Held-key steering: keydown starts the hold (auto-repeat re-sets the same flag, which
      // is idempotent), keyup below ends it.
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { e.preventDefault(); this.setSteer(-1, true); }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { e.preventDefault(); this.setSteer(1, true); }
    };
    this._keyUpHandler = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { this.setSteer(-1, false); }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { this.setSteer(1, false); }
    };
    // Losing focus (alt-tab, click away) has no keyup, so release steering here or the marble
    // keeps drifting into the wall with nothing held.
    this._blurHandler = () => { this._steerLeft = this._steerRight = false; };
    window.addEventListener('keydown', this._keyHandler);
    window.addEventListener('keyup', this._keyUpHandler);
    window.addEventListener('blur', this._blurHandler);
  }
  _unbindKeys() {
    if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler);
    if (this._keyUpHandler) window.removeEventListener('keyup', this._keyUpHandler);
    if (this._blurHandler) window.removeEventListener('blur', this._blurHandler);
  }
}
