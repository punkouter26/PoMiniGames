// game.js — orchestration: phase machine, scoring, the camera director, the rAF loop,
// and C# callbacks.
import { createScene } from './scene.js';
import { createWorld, stepWorld } from './physics.js';
import { generateTrack } from './track.js';
import { createMarbles, MARBLE_ROSTER } from './marbles.js';
import { createAudio } from './audio.js';

const RESULT_MS = 3600;     // how long the result banner shows before next track
const RACE_TIMEOUT = 180;   // s — failsafe for the lengthened chute + friction bands + Gauntlet
const TICK_INTERVAL = 0.1;  // s — throttle for OnRaceTick to C#
const BEST_KEY = 'pomarblerace_best';
const FORM_KEY = 'pomarblerace_form';

// ── The player's verb ──
// Three lateral nudges per race, on a cooldown. This is the entire interactive surface of
// the game, so it is deliberately cheap to use and expensive to waste: a nudge is the
// difference between taking the boost pad line and bouncing off a Gauntlet rotor, but you
// only get three and there is no way to earn more mid-race.
const NUDGE_CHARGES = 3;
const NUDGE_COOLDOWN = 0.6;  // s
const NUDGE_DV = 7.0;        // velocity delta at mass 1 — divided by mass, so heavy marbles resist

// ── Boost pads ──
const BOOST_ACCEL = 30;      // units/s² along the track tangent while on a pad
const BOOST_MAX_SPEED = 95;  // don't let a marble that camps a pad accelerate without bound

// ── Scoring ──
// Placement-weighted, not the old flat "+1 for any top-3". 1st is worth more than 3rd, a
// dominant win is worth more again, and a streak multiplies the lot.
const PLACE_POINTS = [0, 5, 3, 2];   // index by place; 4th-8th score nothing
const DOMINANT_GAP = 1.5;            // s clear of 2nd for the +2 dominant-win bonus
const DOMINANT_BONUS = 2;
const MAX_STREAK_STEPS = 4;          // multiplier caps at 1 + 4*0.5 = 3×

// ── Director ──
const SHOT_LEADER_MS = 5.0;   // s on the leader before considering a cut
const SHOT_PLAYER_MS = 2.2;   // s held on the player once cut to
const BATTLE_DIST = 7;        // units — another marble this close to you is a battle worth showing
const SLOWMO_DIST = 45;       // units from the finish where the leader triggers slow-motion
const SLOWMO_SCALE = 0.35;

// How far under the track centerline a marble may legitimately be before it counts as
// having fallen off. Sized against the banked inner edge of the wide road — see the
// out-of-bounds check in _frame.
const OOB_MARGIN = 48;

// Ceiling on a reported time gap; beyond this the HUD shows "+60s" rather than a number
// whose precision it hasn't earned. See _gapSeconds.
const GAP_MAX = 60;

function loadForm() {
  // Per-marble win/race counts, so the pick screen can show form instead of asking the
  // player to choose a colour blind. Corrupt or absent storage just means a fresh table.
  const empty = { races: new Array(MARBLE_ROSTER.length).fill(0), wins: new Array(MARBLE_ROSTER.length).fill(0) };
  try {
    const raw = JSON.parse(localStorage.getItem(FORM_KEY) || 'null');
    if (!raw || !Array.isArray(raw.races) || !Array.isArray(raw.wins)) return empty;
    if (raw.races.length !== MARBLE_ROSTER.length || raw.wins.length !== MARBLE_ROSTER.length) return empty;
    return raw;
  } catch { return empty; }
}

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
    this.form = loadForm();
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

    // player verb
    this.nudges = NUDGE_CHARGES;
    this.nudgeCd = 0;
    this._wasBoosting = false;

    // director
    this.shot = 'leader';
    this.shotReason = 'LEADER';
    this.shotHold = 0;
    this.slowmo = false;
    this._lastFocus = null;

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
    if (index < 0 || index >= MARBLE_ROSTER.length) return;
    this.chosen = index;
    this.marbleSet.highlight(index);
    this.nudges = NUDGE_CHARGES;
    this.nudgeCd = 0;
    this.shot = 'leader';
    this.shotHold = 0;
    this._setPhase('racing');
    this.raceClock = 0;
    this.tickAccum = TICK_INTERVAL;
    for (const m of this.marbleSet.marbles) m.prevPlace = -1;
    this.scene.followTarget(this.marbleSet.marbles[index].mesh.position, 0, true);
    this.scene.punchFov();   // a quick FOV widen as the race kicks off
    this.audio.resume();
    this.audio.playGun();
  }

  // The player's one in-race input: shove the picked marble sideways. dir is -1 (left) or +1
  // (right) in the local track frame, so it stays intuitive through banked turns and hairpins
  // where world-space X would flip under the player.
  nudge(dir) {
    if (this.phase !== 'racing' || this.demo) return false;
    if (this.nudges <= 0 || this.nudgeCd > 0) return false;
    const m = this.marbleSet.marbles[this.chosen];
    if (!m || m.finished || m.eliminated) return false;

    const rb = this.track.rightAt(m.body.position.z);
    // Impulse / mass: the roster's heavyweights are genuinely harder to steer, which is the
    // trade for the momentum they carry through the Gauntlet.
    const dv = (NUDGE_DV / m.body.mass) * dir;
    m.body.velocity.x += rb.x * dv;
    m.body.velocity.y += rb.y * dv;
    m.body.velocity.z += rb.z * dv;

    this.nudges--;
    this.nudgeCd = NUDGE_COOLDOWN;
    this.audio.playWhoosh();
    this.scene.burstSparks(m.mesh.position, m.spec.color, 10, 1.1);
    this._sendTick();
    return true;
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
    this.slowmo = false;
    this._setPhase('pick');
    this._sendRoster();
    // frame the start gate from above
    const ov = this.track.overviewTarget;
    this.scene.followTarget(ov, 0, true);
  }

  _setPhase(p) {
    this.phase = p;
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
    // pick a random marble after a short beat so the start gate is visible first
    this._demoPickAt = performance.now() + 1200;
  }

  // ── Camera director ──
  // The old camera hard-locked to the player's own marble, so a player running last watched
  // the back of the pack while the actual race happened off-screen. This picks a shot the way
  // a broadcast would: stay on the leader, cut to the player when they're in a fight or when
  // they've been off-screen too long, and never cut mid-slow-motion at the line.
  _pickShot(dt) {
    const lb = this.marbleSet.leaderboard();
    const leader = lb[0];
    const take = (marble, shot, reason, hold) => {
      this.shot = shot;
      this.shotReason = reason;
      if (hold !== undefined) this.shotHold = hold;
      return marble;
    };
    if (this.demo) return take(leader, 'leader', 'LEADER');

    const me = this.marbleSet.marbles[this.chosen];
    const meAlive = me && !me.eliminated && !me.finished;
    if (!meAlive) return take(leader, 'leader', 'LEADER');

    this.shotHold -= dt;
    if (this.shotHold > 0) return this.shot === 'player' ? me : leader;

    // Slow-motion at the line always frames the leader — that's the money shot.
    if (this.slowmo) return take(leader, 'leader', 'FINISH', SHOT_LEADER_MS);

    // If the player IS the leader, or is close enough to be in the leader's frame, one shot
    // covers both and there's nothing to cut to.
    if (me.place >= 1 && me.place <= 3) return take(leader, 'leader', 'LEADER', SHOT_LEADER_MS);

    // A battle: someone is right on top of the player. Cut to it.
    const inBattle = this.marbleSet.marbles.some((o) =>
      o !== me && !o.eliminated && !o.finished &&
      Math.abs(o.body.position.z - me.body.position.z) < BATTLE_DIST);

    if (this.shot === 'leader' || inBattle) {
      this.scene.punchFov();
      return take(me, 'player', inBattle ? 'BATTLE' : 'YOU', inBattle ? SHOT_PLAYER_MS * 1.4 : SHOT_PLAYER_MS);
    }
    return take(leader, 'leader', 'LEADER', SHOT_LEADER_MS);
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

  _frame(dt) {
    // demo auto-pick
    if (this.demo && this.phase === 'pick' && this._demoPickAt && performance.now() >= this._demoPickAt) {
      this._demoPickAt = 0;
      this.pick(Math.floor(Math.random() * MARBLE_ROSTER.length));
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
      stepWorld(this.world, sdt);
      this.marbleSet.sync();
      for (const t of this.track.turnstiles) { t.mesh.position.copy(t.body.position); t.mesh.quaternion.copy(t.body.quaternion); }

      if (this.nudgeCd > 0) this.nudgeCd -= dt;

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
      const leaderNow = this.marbleSet.leaderboard()[0];
      const nearFinish = leaderNow
        ? 1 - Math.max(0, Math.min(1, (this.track.finishZ - leaderNow.body.position.z) / 400))
        : 0;
      this.audio.updateBeds(leaderNow ? leaderNow.speed : 0, nearFinish, this.phase === 'racing');

      // Snap on a shot change rather than lerping across the track: a director's cut is a
      // cut. Lerping between two marbles 200 units apart reads as the camera losing the race.
      const focus = this._pickShot(dt);
      if (focus) {
        this.scene.followTarget(focus.mesh.position, dt, focus !== this._lastFocus);
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
    const won = finished && place >= 1 && place <= 3;

    let gained = 0;
    if (won) {
      let base = PLACE_POINTS[place];
      // A dominant win — clear of 2nd by DOMINANT_GAP — is worth more than scraping home
      // first. This is where finish TIME finally enters the score: it used to be computed
      // and displayed and then thrown away entirely.
      if (place === 1 && order.length > 1 && order[1].finished &&
          (order[1].finishTime - me.finishTime) >= DOMINANT_GAP) {
        base += DOMINANT_BONUS;
      }
      this.streak += 1;
      const mult = 1 + Math.min(this.streak - 1, MAX_STREAK_STEPS) * 0.5;
      gained = Math.round(base * mult);
      this.score += gained;
    } else {
      // The run ends. Score used to be a strictly-increasing counter that never reset, which
      // made "best" identical to "score" and turned the global board into a measure of how
      // long a tab was left open. A miss now costs the whole run — that's the stake that
      // makes a streak worth watching.
      this.streak = 0;
      this.score = 0;
    }
    if (this.score > this.best) { this.best = this.score; try { localStorage.setItem(BEST_KEY, String(this.best)); } catch { } }

    // Roster form: every marble that finished this race gets a start, the top 3 get a win.
    for (const m of this.marbleSet.marbles) {
      if (m.eliminated) continue;
      this.form.races[m.index] = (this.form.races[m.index] || 0) + 1;
      if (m.finished && m.place >= 1 && m.place <= 3) this.form.wins[m.index] = (this.form.wins[m.index] || 0) + 1;
    }
    try { localStorage.setItem(FORM_KEY, JSON.stringify(this.form)); } catch { }

    this.resultTimer = RESULT_MS / 1000;
    this._setPhase('result');
    this.audio.playSting(won);
    this._sendTick(); // final standings
    this._invoke('OnRaceResult', won, place, this.score, gained, this.streak, this.best);
  }

  // C# is handed parallel primitive arrays rather than a JSON string: the string form was
  // serialized by us, serialized again by the interop layer, then parsed a third time on the
  // C# side — every tick for a whole race. Colours are omitted entirely; C# derives them from
  // the marble index (its Roster array mirrors MARBLE_ROSTER).
  _invoke(method, ...args) {
    if (!this.dotnet) return;
    // invokeMethodAsync rejects asynchronously, so a bare try/catch here would never see the
    // failure — it has to be caught on the promise.
    try {
      const p = this.dotnet.invokeMethodAsync(method, ...args);
      if (p && p.catch) p.catch(() => { });
    } catch { }
  }

  // Grid slots + running form, so the pick screen can show what it's actually asking the
  // player to choose between. Sent once per track, at pick time.
  _sendRoster() {
    this._invoke('OnRoster', this.track.gridSlots, this.form.wins, this.form.races);
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

    const round2 = (v) => Math.round(v * 100) / 100;
    this._invoke('OnRaceTick',
      order.map((m) => m.index),
      order.map((m) => Math.round(m.speed * 10) / 10),
      order.map((m) => m.finished),
      order.map((m) => (m.finished ? round2(m.finishTime) : 0)),
      order.map((m) => round2(this._gapSeconds(m, leader))),
      this.marbleSet.progress(),
      me && !me.eliminated ? this.marbleSet.progressOf(me) : 0,
      round2(this.raceClock),
      this.nudges,
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
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { e.preventDefault(); this.nudge(-1); }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { e.preventDefault(); this.nudge(1); }
    };
    window.addEventListener('keydown', this._keyHandler);
  }
  _unbindKeys() { if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler); }
}
