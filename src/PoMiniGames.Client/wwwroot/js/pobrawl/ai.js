// ai.js — CPU fighter. Emits the same intent shape as KeyboardController so the game
// treats human and CPU fighters identically.

import { PERSONALITIES } from './personalities.js';
//
// Frame-data awareness: the AI receives the opponent's current attack phase
// (windup/active/recover) and the recovery window of each of its own attacks.
// It will:
//   • block during opponent windup with probability by difficulty, but only
//     once the windup has been visible for this rung's reaction floor — so a
//     jab is never reactively blocked and a held coil always is
//   • throw its fastest attack when the opponent is in active/recover (whiff punish)
//   • occasionally commit to a blocked attack then cancel into block (bait)
//   • back off after taking quick consecutive hits (anti-stunlock)
//   • occasionally wind up a held CHARGE attack while the opponent is stuck
//     in hitstun (the coil pose is the player's tell to block the release)
//   • load a full coil at an opponent who has GASSED their energy bar out —
//     the punish for spending the whole bar on offence, and the reason the
//     guard is worth learning, since blocking is what refills it
//
// In-match adaptation: the AI also reads the opponent's habits over a rolling
// ~8-second window and shifts its weights —
//   • turtles (blocking a big share of in-range time) draw more kicks, because
//     the guard capsules only cover the forearms so kicks to the legs land
//     through a standing block, plus more feint-baits
//   • spammers (high attack rate) get blocked and whiff-punished more often
// Adaptation strength scales with the rung, so a level-2 president barely
// adjusts while a level-9 one counters your gameplan within a few exchanges.

// Fifteen numeric skill rungs for the 1-player presidents ladder. Level 1 is
// gentle but no longer a statue; level 15 is a wall (superhuman reactions,
// near-perfect blocking and whiff punishing, relentless).
// `aggro` scales how often the AI chooses to attack at all. `comboP` is the
// chance a committed punch is pre-planned as a punch→kick cancel string —
// only rungs 5+ know the cancel table exists. The top five rungs (LBJ-FDR)
// tighten reactions past human reflexes and lean on more baits and combos
// rather than just faster reads — diminishing returns on raw reactionMs.
//
// ── 2026-09-12 rebalance (user request: "more difficult, each level harder
// than the last, force the player to learn to block") ─────────────────────
// Two problems with the old curve. First, rungs 1-4 were not a difficulty ramp
// so much as a tutorial that lasted four fights: at aggro 0.35 / blockP 0.03 a
// rung-1 president mostly stood there, and a player could clear the first third
// of the ladder mashing punch without ever pressing block. Second, the curve
// went nearly flat above rung 10 — 11 through 15 differed by ~35 ms of reaction
// and nothing else, so the last five fights felt like the same opponent.
//
// The floor is raised (rung 1 now guards and punishes a little, which is what
// teaches the block button exists) and the top is pushed out along the axes
// that still have room — aggro, comboP, baitP, and the two new columns:
//
//   chargeP  — how readily this rung commits to a HELD coil instead of a tap.
//              This is the column that does the forcing: a coil is the one
//              swing a player genuinely cannot trade with, so the guard is the
//              only answer. It replaces the old formula-derived value.
//   punishGas — chance per opening to load a full coil at an opponent who has
//              gassed their energy bar out. Spending the bar on offence and
//              then standing there is the mistake this punishes, and blocking
//              is what refills it — so the counter and the lesson agree.
const LEVELS = [
  /*  1 */ { reactionMs: 700, blockP: 0.10, baitP: 0.00, punishP: 0.08, aggro: 0.55, comboP: 0.00, chargeP: 0.12, punishGas: 0.15 },
  /*  2 */ { reactionMs: 600, blockP: 0.18, baitP: 0.00, punishP: 0.16, aggro: 0.66, comboP: 0.00, chargeP: 0.16, punishGas: 0.22 },
  /*  3 */ { reactionMs: 510, blockP: 0.27, baitP: 0.02, punishP: 0.26, aggro: 0.76, comboP: 0.00, chargeP: 0.20, punishGas: 0.30 },
  /*  4 */ { reactionMs: 435, blockP: 0.36, baitP: 0.04, punishP: 0.37, aggro: 0.86, comboP: 0.00, chargeP: 0.24, punishGas: 0.38 },
  /*  5 */ { reactionMs: 370, blockP: 0.45, baitP: 0.06, punishP: 0.47, aggro: 0.95, comboP: 0.15, chargeP: 0.28, punishGas: 0.46 },
  /*  6 */ { reactionMs: 315, blockP: 0.54, baitP: 0.09, punishP: 0.57, aggro: 1.03, comboP: 0.25, chargeP: 0.32, punishGas: 0.54 },
  /*  7 */ { reactionMs: 268, blockP: 0.62, baitP: 0.12, punishP: 0.66, aggro: 1.10, comboP: 0.35, chargeP: 0.36, punishGas: 0.62 },
  /*  8 */ { reactionMs: 228, blockP: 0.70, baitP: 0.15, punishP: 0.74, aggro: 1.17, comboP: 0.44, chargeP: 0.40, punishGas: 0.69 },
  /*  9 */ { reactionMs: 194, blockP: 0.77, baitP: 0.18, punishP: 0.81, aggro: 1.23, comboP: 0.52, chargeP: 0.44, punishGas: 0.75 },
  /* 10 */ { reactionMs: 166, blockP: 0.83, baitP: 0.21, punishP: 0.87, aggro: 1.29, comboP: 0.59, chargeP: 0.48, punishGas: 0.80 },
  /* 11 */ { reactionMs: 143, blockP: 0.88, baitP: 0.25, punishP: 0.91, aggro: 1.33, comboP: 0.66, chargeP: 0.52, punishGas: 0.85 },
  /* 12 */ { reactionMs: 126, blockP: 0.91, baitP: 0.29, punishP: 0.94, aggro: 1.37, comboP: 0.72, chargeP: 0.56, punishGas: 0.89 },
  /* 13 */ { reactionMs: 113, blockP: 0.93, baitP: 0.33, punishP: 0.96, aggro: 1.41, comboP: 0.78, chargeP: 0.60, punishGas: 0.92 },
  /* 14 */ { reactionMs: 103, blockP: 0.95, baitP: 0.37, punishP: 0.98, aggro: 1.46, comboP: 0.84, chargeP: 0.64, punishGas: 0.95 },
  /* 15 */ { reactionMs:  95, blockP: 0.97, baitP: 0.42, punishP: 1.00, aggro: 1.50, comboP: 0.90, chargeP: 0.68, punishGas: 0.98 },
];

// Top-of-the-ladder rung count: rung index doubles as the CPU difficulty level
// (index + 1 → 1..15). Kept in sync with Roster.Length in PoBrawlPage.razor.
export const MAX_RUNG = 15;

// Habit-tracker tuning. The rolling window is an exponential decay so recent
// behavior dominates; thresholds are the point past which a habit is "read".
const HABIT_TAU = 8;          // seconds of memory
const TURTLE_THRESHOLD = 0.35; // fraction of in-range time spent blocking
const SPAM_THRESHOLD = 0.5;    // opponent attacks per second

// Legacy string difficulties (used by demo / 2p fallbacks) map onto rungs.
const NAMED_LEVELS = { easy: 2, medium: 5, hard: 8 };

export class AiController {
  /** difficulty: 1-15 rung number, or 'easy' | 'medium' | 'hard'.
   *  charId: optional president id used to apply personality modifiers. */
  constructor(difficulty, rng = null, charId = null) {
    const level = typeof difficulty === 'number'
      ? Math.max(1, Math.min(MAX_RUNG, Math.round(difficulty)))
      : (NAMED_LEVELS[difficulty] || NAMED_LEVELS.medium);
    const p = LEVELS[level - 1];
    this.level = level;
    this.reactionMs = p.reactionMs;
    this.blockP = p.blockP;
    this.baitP = p.baitP;
    this.punishP = p.punishP;
    this.aggro = p.aggro;
    this.comboP = p.comboP;
    this.punishGasP = p.punishGas;
    // How hard the habit reads bend the weights: level 1 ≈ 0.07, level 15 = 1.
    this.adapt = level / MAX_RUNG;

    // ── Rung-scaled pattern delivery ──────────────────────────────────
    // The phrases in personalities.js are written at their LOW-rung tempo; the
    // rung decides how fast they are executed and how often they open. Without
    // this a rung-15 president ran its signature at exactly the pace a rung-1
    // one did, which is most of why the top of the ladder used to feel flat:
    // the numbers got sharper but the fight did not get faster.
    //
    // 1.10 → 0.76 dwell: a top-rung coil is about a quarter shorter, which is
    // still long enough to see and block. Going below ~0.7 starts eating the
    // tell itself, and an unreadable phrase is just damage, not difficulty.
    this.patTempo = 1.10 - 0.34 * ((level - 1) / (MAX_RUNG - 1));
    // 1.20 → 0.68 cadence: the top of the ladder opens a phrase roughly every
    // 3.5 s where the bottom takes 6.5 s, so pressure scales with the rung too.
    this.patCadence = 1.20 - 0.52 * ((level - 1) / (MAX_RUNG - 1));

    // ── Reactive-block reaction floor ─────────────────────────────────
    // How long an opponent's wind-up must have been VISIBLE before the reactive
    // block below is allowed to answer it. Without one the guard went up on the
    // first frame of the wind-up, because the AI reads the state machine rather
    // than the animation — at rung 15 that meant a 97% chance of blocking a jab
    // whose entire wind-up is four frames, which is not a hard opponent so much
    // as an unbeatable one. Worse under the perfect-guard rules the engine now
    // applies to both sides (game.js PERFECT_GUARD_WINDOW): a frame-0 guard is
    // always "perfect", so every jab you threw handed back a free counter.
    //
    // 0.28 s at rung 1 down to 0.09 s at rung 15, against the frame data in
    // game.js ATTACKS (punch wind-up 0.06 s, kick 0.12 s, a held coil as long as
    // it is held). The resulting rule is simple enough for a player to feel:
    //   • nobody can react to a bare jab — trading jabs is always live;
    //   • only the last two rungs get under a kick's 0.12 s wind-up;
    //   • a held coil is long enough for anyone to answer, so whether it gets
    //     guarded is down to blockP alone — which is the point of rolling that
    //     once per swing rather than per tick (see the reactive-defense block).
    this.reactFloor = 0.28 - 0.19 * ((level - 1) / (MAX_RUNG - 1));
    // Engine time the opponent's current wind-up began, or -1 between swings,
    // and whether this rung has already taken its single block roll on it.
    this._oppWindupSince = -1;
    this._windupRolled = false;

    // Personality (charId) layer. Optional additive AI knobs (e.g. HW Bush's
    // "Read My Lips" / "Voodoo Feints" — +12% blockP, +10% punishP, +30% baitP).
    // The engine instantiates this controller with `charId` when known.
    this.charId = charId;
    this._personalityMods = { blockP: 0, baitP: 0, punishP: 0 };
    if (this.charId && PERSONALITIES[this.charId]?.passiveAiBoost) {
      const b = PERSONALITIES[this.charId].passiveAiBoost;
      this._personalityMods = { ...b };
      this.blockP = Math.min(0.98, this.blockP + (b.blockP || 0));
      this.baitP = Math.min(0.6, this.baitP + (b.baitP || 0));
      this.punishP = Math.min(0.98, this.punishP + (b.punishP || 0));
    }

    this.rng = rng || { random: Math.random };
    this.sinceDecision = 1e9;
    this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
    this.retreatUntil = 0;
    this.recentHits = [];
    this.t = 0;
    // Used to occasionally start a swing then cancel to block on the next decision.
    this.baitArmed = false;
    this.baitStartedAt = 0;
    // Hold-to-charge plan: while holdName is set the AI keeps the button
    // held (the engine charges the attack), releasing at holdUntil. Higher
    // rungs charge more often and wind up longer.
    this.holdName = null;
    this.holdUntil = 0;
    this.chargeP = p.chargeP;
    // Signature pattern state (see _runPattern). `_pat` is the phrase currently
    // playing out, `_patReadyAt` the wall-clock time the next one may open.
    //
    // These replace the old bidenChargeReadyAt / obamaComboReadyAt pair. Those
    // were two hand-written `if (this.charId === 'x')` blocks — the only two
    // presidents whose fighting STYLE differed at all, which is why the other
    // thirteen were mechanically interchangeable at a given rung. Both are now
    // ordinary rows in the same data table as everyone else.
    this._pat = null;
    // Repertoire cursor. Every president owns an ordered array of phrases
    // (personalities.js `aiPatterns`) and the rung decides how many of them are
    // in play — see _unlockedPatterns. `_patIdx` walks that window in a fixed
    // cycle, never a random pick, so the ORDER is learnable the same way the
    // steps inside one phrase are.
    this._patIdx = 0;
    // Stagger the first opening so a fighter does not lead with its signature
    // before the player has seen it fight normally — and so demo pairings do
    // not open in lockstep. Seeded RNG, so replays stay deterministic.
    this._patReadyAt = 1.2 + this.rng.random() * 1.5;
    // Pre-planned punch→kick cancel string (rungs 5+): fire the kick edge when
    // t reaches comboAt, drop the plan if the window is missed.
    this.comboAt = 0;
    this.comboUntil = 0;
    // Rolling habit counters (exponentially decayed, HABIT_TAU memory).
    this.obsT = 0;       // decayed in-range observation time
    this.oppBlockT = 0;  // decayed in-range time the opponent spent blocking
    this.oppAtkN = 0;    // decayed count of opponent attack starts
    this.clockT = 0;     // decayed total time (normalizer for the attack rate)
    this.prevOppWindup = false;
  }

  notifyHit() {
    this.recentHits.push(this.t);
    this.recentHits = this.recentHits.filter((h) => this.t - h < 1.5);
    if (this.recentHits.length >= 2) this.retreatUntil = this.t + 0.7;
    // Taking a hit dumps any charge the engine was holding for us.
    this.holdName = null;
    // ...and breaks the signature phrase. This is the counterplay: every
    // pattern has a moment where it is committed and open, and a player who has
    // learned to read it gets to cut it off there. Without this the phrase
    // would play through the interruption and reading it would earn nothing.
    this._pat = null;
  }

  /**
   * ctx shape (extended by the engine):
   *   { dt, distance, kickRange,
   *     opponentState, opponentStateT,           // 'punch'|'kick'|'hitstun'|...
   *     opponentWindup, opponentActive, opponentRecover, // booleans this tick
   *     selfExhausted, opponentExhausted,        // energy gate, both sides
   *     ownAttacks: { punch: {...}, kick: {...} } // with windup/active/recover
   *   }
   */
  // ── Habit tracking ────────────────────────────────────────────────────
  // Decayed counters: multiply by exp(-dt/tau) each tick, then add this tick's
  // observation, so the read always reflects roughly the last HABIT_TAU seconds.
  _observe(ctx) {
    const decay = Math.exp(-ctx.dt / HABIT_TAU);
    const inRange = ctx.distance < ctx.kickRange * 1.25;
    this.obsT = this.obsT * decay + (inRange ? ctx.dt : 0);
    this.oppBlockT = this.oppBlockT * decay
      + (inRange && ctx.opponentState === 'block' ? ctx.dt : 0);
    this.clockT = this.clockT * decay + ctx.dt;
    this.oppAtkN *= decay;
    if (ctx.opponentWindup && !this.prevOppWindup) {
      this.oppAtkN += 1;
      // Stamp the frame the wind-up became visible; the reactive block measures
      // its reaction floor from here rather than firing on the same tick.
      this._oppWindupSince = this.t;
      this._windupRolled = false;
    }
    if (!ctx.opponentWindup) this._oppWindupSince = -1;
    this.prevOppWindup = ctx.opponentWindup;
  }

  // 0..1 — how much of recent in-range time the opponent spent blocking.
  _turtleRead() {
    if (this.obsT < 1.5) return 0; // not enough evidence yet
    return Math.max(0, this.oppBlockT / this.obsT - TURTLE_THRESHOLD);
  }

  // Attacks/sec above the spam threshold (0 when calm).
  _spamRead() {
    if (this.clockT < 1.5) return 0;
    return Math.max(0, this.oppAtkN / this.clockT - SPAM_THRESHOLD);
  }

  // ── Signature pattern runner ──────────────────────────────────────────
  // Every president owns an ordered repertoire of scripted phrases
  // (personalities.js `aiPatterns`) that it cycles on a fixed cadence for the
  // whole fight. This is the layer that makes the roster feel like fifteen
  // fighters instead of one fighter in fifteen skins: the rung table above
  // decides how SHARP a president is, and the repertoire decides how it FIGHTS.
  //
  // The design constraint is learnability, so neither the script nor the order
  // it is played in is randomised. Same trigger, same order, same rhythm, every
  // time — that is what lets a player who has lost to Nixon four times notice
  // he always backs off a beat before he lunges, and start punishing the
  // retreat. A pattern that varied would just read as noise.
  //
  // Three properties keep it fair rather than oppressive:
  //   • it only starts in range and off cooldown, so it cannot chase you down;
  //   • landing a hit CANCELS it (see notifyHit) — every phrase has a window
  //     where interrupting beats it, which is the reward for reading it;
  //   • it is a phrase, not a loop, so there is always recovery time after.

  /**
   * How much of this president's repertoire this rung is allowed to use.
   * Low rungs run one phrase, the middle alternates two, the top cycles all
   * three. This is a difficulty axis the numeric table cannot express: a rung-2
   * president is beaten by learning ONE tell, while a rung-13 one makes you
   * learn a three-phrase song before the reads pay off. It is also why the
   * entries in `aiPatterns` are ordered — index 1 is written as the answer to
   * having learned index 0.
   */
  _unlockedPatterns() {
    const all = PERSONALITIES[this.charId]?.aiPatterns;
    if (!all || !all.length) return null;
    // 1..5 → 1 phrase, 6..10 → 2, 11..15 → 3 (clamped to what exists).
    const depth = Math.min(all.length, 1 + Math.floor((this.level - 1) / 5));
    return all.slice(0, depth);
  }

  _patternDue(ctx) {
    const set = this._unlockedPatterns();
    if (!set || this.holdName || this.t < this.retreatUntil) return false;
    if (this.t < this._patReadyAt) return false;
    // Range gate: measured against the NEXT phrase's own reach so a crowding
    // phrase (LBJ) can open from further out than a counter-punch (Bush Sr.).
    const pat = set[this._patIdx % set.length];
    return ctx.distance < ctx.kickRange * (pat.range || 1.2);
  }

  _startPattern(ctx) {
    const set = this._unlockedPatterns();
    const pat = set[this._patIdx % set.length];
    // Advance the cursor on OPEN, not on finish: a phrase that gets interrupted
    // still counts as played, so cutting one off moves the fight on to the next
    // one instead of replaying the phrase the player just proved they can read.
    this._patIdx = (this._patIdx + 1) % set.length;
    // Rung tempo scales the dwell of every step, so the same written phrase is
    // a slow, obvious lesson low on the ladder and a tight one at the top.
    this._pat = {
      steps: pat.steps, i: 0, until: 0, fired: false, tempo: this.patTempo,
    };
    // Cadence is measured from the START of the phrase, so the gap a player
    // learns to count is the gap between openings, not between endings.
    this._patReadyAt = this.t + (pat.everySecs || 5) * this.patCadence;
    // A phrase supersedes any half-formed plan from the random layer.
    this.baitArmed = false;
    this.comboAt = 0;
    this.comboUntil = 0;
  }

  // Returns an intent while the phrase is mid-flight, or null once it ends
  // (letting the normal decision loop resume on the same tick).
  _runPattern(ctx) {
    const p = this._pat;
    const step = p.steps[p.i];
    if (!step) { this._pat = null; return null; }

    // Entering a step: stamp its dwell and let this tick carry the press edge.
    // `tempo` is the rung's execution speed (see _startPattern) — the same
    // written phrase, delivered faster the higher up the ladder you are.
    if (p.until === 0) {
      p.until = this.t + (step.secs || 0.2) * p.tempo;
      p.fired = false;
    }

    const done = this.t >= p.until;
    const out = this._stepIntent(step, p.fired);
    p.fired = true;

    if (done) {
      p.i += 1;
      p.until = 0;
      // Dropping the held flag on the frame a `charge` step ends is what makes
      // the engine release the strike — the release is the step boundary.
      if (p.i >= p.steps.length) {
        this._pat = null;
        this.sinceDecision = 0;
      }
    }
    return out;
  }

  // One step → one intent. `edgeSpent` suppresses the press edge on every frame
  // after the first: punch/kick are edge-triggered, and re-pressing each frame
  // would restart the swing the moment the engine returned to idle.
  _stepIntent(step, edgeSpent) {
    const base = { move: 0, side: 0, punch: false, kick: false, block: false, super: false };
    const atk = step.attack || 'punch';
    switch (step.act) {
      case 'punch':
      case 'kick':
        return edgeSpent ? base : { ...base, [step.act]: true };
      case 'charge': {
        // Press once, then hold. The engine charges for as long as *Held is
        // set and throws the strike when it drops — see _tickFighter's charge
        // case — so the visible coil IS this step's duration.
        const out = { ...base, [atk + 'Held']: true };
        if (!edgeSpent) out[atk] = true;
        return out;
      }
      case 'block':    return { ...base, block: true };
      case 'advance':  return { ...base, move: 1 };
      case 'retreat':  return { ...base, move: -1 };
      // Held for the step's whole duration, not edge-triggered: `side` became a
      // sustained orbit when the circle keys landed, so a one-frame pulse would
      // have quietly turned every sidestep phrase (Obama, Clinton, JFK) into a
      // pause the player could not see.
      case 'sidestep': return { ...base, side: step.dir || -1 };
      case 'wait':
      default:         return base;
    }
  }

  /**
   * Commit to a held coil and return the intent that starts it.
   *
   * The engine charges for as long as `<name>Held` is set and throws the strike
   * on the frame it drops, so the hold window IS the visible wind-up the player
   * reads. One helper for all three coil triggers (gas punish, hitstun, open
   * guard) because they differ only in how long they load and how much they
   * favour the kick — inlining it three times is how the first two drifted
   * apart on which plans they remembered to clear.
   *
   * @param kickBias 0..1 chance the coil is a kick rather than a punch.
   * @param spread   seconds of extra hold on top of the 0.45 s base.
   */
  _loadCharge(kickBias, spread) {
    const name = this.rng.random() < kickBias ? 'kick' : 'punch';
    this.holdName = name;
    this.holdUntil = this.t + 0.45 + this.rng.random() * spread;
    this.baitArmed = false;
    this.comboAt = 0;
    this.comboUntil = 0;
    this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
    const out = { ...this.current };
    out[name] = true;            // press edge starts the charge
    out[name + 'Held'] = true;   // and the hold keeps it winding
    return out;
  }

  update(ctx) {
    this.t += ctx.dt;
    this.sinceDecision += ctx.dt * 1000;
    this._observe(ctx);

    // Habit-adjusted probabilities for this tick. Spammers get blocked and
    // whiff-punished more; the bumps are capped so low rungs stay beatable.
    const spam = this._spamRead();
    const turtle = this._turtleRead();
    const effBlockP = Math.min(0.95, this.blockP + spam * 0.5 * this.adapt);
    const effPunishP = Math.min(0.95, this.punishP + spam * 0.4 * this.adapt);
    const effBaitP = Math.min(0.5, this.baitP + turtle * 0.4 * this.adapt);

    // Edge-triggered flags are consumed each read; holds (move/block) persist.
    const intent = { ...this.current, punch: false, kick: false, side: 0 };

    // ── Gassed out ──────────────────────────────────────────────────────
    // Energy is under the floor, so the engine will refuse every punch and kick
    // until the bar recovers (game.js _canAttack). Guard and hold — blocking is
    // by far the fastest refill, so this is both the correct play and the way
    // out. Placed ahead of the pattern runner and the charge hold deliberately:
    // both of those would otherwise keep feeding attack inputs into a closed
    // gate for the whole recovery, which looks like the CPU freezing up.
    //
    // Backing off while gassed keeps the CPU from simply standing in range
    // eating a free combo, but it stays in the fight rather than fleeing.
    if (ctx.selfExhausted) {
      this._pat = null;
      this.holdName = null;
      this.sinceDecision = 0;
      const backoff = ctx.distance < ctx.kickRange * 0.9 ? -1 : 0;
      this.current = { move: backoff, side: 0, punch: false, kick: false, block: true };
      return { ...this.current, super: false };
    }

    // ── Signature pattern ───────────────────────────────────────────
    // A running script owns the fighter outright until it finishes or is
    // interrupted, so it plays out as one readable phrase rather than being
    // diluted by the random weights below.
    if (this._pat) {
      const out = this._runPattern(ctx);
      if (out) return out;
    } else if (this._patternDue(ctx)) {
      this._startPattern(ctx);
      const out = this._runPattern(ctx);
      if (out) return out;
    }

    // ── Active charge hold ──────────────────────────────────────────────
    // A charge plan overrides everything: keep the button held until the
    // release time, then drop the held flag so the engine throws the strike.
    if (this.holdName) {
      if (this.t < this.holdUntil) {
        const out = { move: 0, side: 0, punch: false, kick: false, block: false, super: false };
        out[this.holdName + 'Held'] = true;
        return out;
      }
      this.holdName = null;
      this.sinceDecision = 0;
      return { move: 0, side: 0, punch: false, kick: false, block: false, super: false };
    }

    // ── Signature super activation ────────────────────────────────────
    // When the comeback meter is full, the AI spends it on its signature
    // move. Rung drives the chance per tick (low rungs hoard the meter, high
    // rungs know exactly when to spend). The engine handles the actual
    // application — the AI just signals `intent.super = true` once.
    //
    // Cooldown: a hard-coded 4-second window after firing before the AI is
    // allowed to fire again. Prevents accidental back-to-back activations
    // from a refill before the meter has had time to build. The intent.super
    // edge is consumed by the engine after the first read (intent is dropped
    // by the engine after _fireSuper returns), so this is naturally one-shot
    // per meter fill.
    if (ctx.superMeterFull && this.t >= (this.superCooldownUntil || 0)) {
      // Ramp-up: low rungs fire rarely, high rungs fire on the first full
      // tick they can. The gate is a per-tick probability scaled by rung.
      const superP = Math.min(0.85, 0.15 + (this.level - 1) * 0.05);
      // Don't fire into the windup of an opponent swing we're blocking —
      // it's a wasted activation if they're not in range / not in stun.
      const oppVulnerable = ctx.opponentState === 'hitstun'
        || ctx.opponentState === 'block'
        || (ctx.opponentWindup && ctx.distance < ctx.kickRange * 1.1)
        || ctx.opponentState === 'idle';
      if (oppVulnerable && this.rng.random() < superP) {
        this.superCooldownUntil = this.t + 4.0;
        return { move: 0, side: 0, punch: false, kick: false, block: false, super: true };
      }
    }

    // ── Pre-planned cancel string (rungs 5+) ────────────────────────────
    // A punch committed with a combo plan cancels into kick exactly when the
    // frame-data window opens. Fires outside the reaction gate — the string
    // was decided when the punch started, not as a reaction.
    if (this.comboAt > 0 && this.t >= this.comboAt) {
      const missed = this.t > this.comboUntil
        || ctx.distance > ctx.kickRange * 1.1;
      this.comboAt = 0;
      this.comboUntil = 0;
      if (!missed) {
        this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
        this.sinceDecision = 0;
        return { ...this.current, kick: true };
      }
    }

    // ── Reactive defense ────────────────────────────────────────────────
    // Block during the opponent's windup, but only once it has been visible for
    // this rung's reaction floor — see the constructor. A swing whose whole
    // wind-up is shorter than the floor simply cannot be answered this way,
    // which is what keeps fast pokes live against the top of the ladder.
    //
    // ONE roll per swing, not one per tick. This used to re-roll every frame the
    // windup was up, which quietly made blockP a function of how long the swing
    // took rather than of the rung: over the ~25 frames of a held coil even
    // blockP 0.10 compounded to a ~93% guard, so a rung-1 president defended a
    // haymaker about as well as a rung-15 one and the column did almost nothing
    // where it mattered most. Rolled once, blockP means what its name says —
    // the chance THIS swing gets guarded — and the ladder separates properly.
    const windupSeen = this._oppWindupSince >= 0
      && (this.t - this._oppWindupSince) >= this.reactFloor;
    if (windupSeen && !this._windupRolled && ctx.distance < ctx.kickRange * 1.25) {
      this._windupRolled = true;
      if (!this.current.block && this.rng.random() < effBlockP) {
        this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
        this.sinceDecision = 0;
        this.baitArmed = false;
        this.comboAt = 0;
        this.comboUntil = 0;
        return { ...this.current };
      }
    }

    if (this.sinceDecision < this.reactionMs) return intent;
    this.sinceDecision = 0;

    // ── Anti-stunlock retreat ───────────────────────────────────────────
    if (this.t < this.retreatUntil) {
      this.current = { move: -1, side: 0, punch: false, kick: false, block: false };
      return { ...this.current };
    }

    // ── Gas punish: the opponent spent their bar, so make them pay ─────
    // A gassed fighter cannot punch or kick at all until the bar recovers
    // (game.js _canAttack), and the fastest route back up is the guard. So an
    // opponent standing there gassed is either about to block — in which case a
    // coil is the right call anyway, since a blocked charge is the one thing
    // that refills them — or about to eat the biggest swing in the game.
    //
    // This is the sharpest end of "learn to block": a player who empties the
    // bar mashing attack gets a fully loaded coil aimed at them for their
    // trouble, and the only way out of it is the button they were not pressing.
    // Ahead of the hitstun coil below because it is the better read of the two
    // when both are true — hitstun lasts 0.35 s, the gas window lasts seconds.
    if (ctx.opponentExhausted && ctx.distance < ctx.kickRange * 1.15
        && this.rng.random() < this.punishGasP) {
      return this._loadCharge(0.55, 0.55);
    }

    // ── Charged attack: wind up while the opponent can't answer ────────
    // The opponent is stuck in hitstun and in range — occasionally commit to
    // a held charge instead of a tap. The visible coil is the player's cue
    // to block or interrupt when the stun wears off.
    if (ctx.opponentState === 'hitstun' && ctx.distance < ctx.kickRange
        && this.rng.random() < this.chargeP) {
      return this._loadCharge(0.45, 0.5);
    }

    // ── Open-guard coil: punish a player who never blocks ──────────────
    // The opponent is in range, doing nothing in particular, and NOT guarding.
    // Higher rungs read that as an invitation and commit to a coil rather than
    // a jab. The turtle read damps it — against a player who does guard there
    // is no lesson left to teach here, and kicks are already the better answer
    // (see the kick shift below), so the AI stops spending the wind-up.
    if (ctx.opponentState === 'idle' && ctx.distance < ctx.kickRange
        && this.rng.random() < this.chargeP * 0.5 * (1 - Math.min(1, turtle * 2))) {
      return this._loadCharge(0.4, 0.45);
    }

    // ── Out of range: approach, occasionally circle in ──────────────────
    // The circle is now stored ON this.current rather than tacked onto the
    // returned copy. `side` used to be an edge-triggered dart, so one frame of
    // it was a whole sidestep; it is a held orbit direction now, and a single
    // frame of that is an imperceptible nudge. Keeping it on `current` means it
    // persists until the next decision tick, which is what makes the AI arc in
    // rather than walk a straight line.
    if (ctx.distance > ctx.kickRange) {
      const side = this.rng.random() < 0.18 ? (this.rng.random() < 0.5 ? 1 : -1) : 0;
      this.current = { move: 1, side, punch: false, kick: false, block: false };
      this.baitArmed = false;
      return { ...this.current };
    }

    // ── In range: frame-data aware choices ──────────────────────────────
    // 1) If opponent is in active/recover, whiff-punish with our fastest move.
    // 2) If a bait is armed and we're past its window, cancel into block.
    // 3) Otherwise weight: punch (35%), kick (25%), block (15%), retreat (10%), wait (15%).
    if (this.baitArmed && (this.t - this.baitStartedAt) > (ctx.ownAttacks.punch.windup + 0.02)) {
      // Cancel the bait into block — looks like the AI feinted.
      this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
      this.baitArmed = false;
      return { ...this.current };
    }

    if ((ctx.opponentActive || ctx.opponentRecover) && this.rng.random() < effPunishP) {
      // Punch is the fastest move — best for punishing recovery.
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      return { ...this.current, punch: true };
    }

    // Attack shares scale with the rung's aggression; the leftover probability
    // shifts into block/retreat/wait, so low rungs mostly shuffle around.
    // Vs a turtle, punch share shifts into kick: the guard only covers the
    // forearms, so kicks to the legs connect through a standing block.
    const r = this.rng.random();
    let pPunch = 0.35 * this.aggro;
    let pKick = 0.25 * this.aggro;
    const kickShift = Math.min(pPunch * 0.6, turtle * 0.8 * this.adapt);
    pPunch -= kickShift;
    pKick += kickShift;
    if (r < pPunch) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      // Rungs 5+ sometimes commit to the punch as the opener of a
      // punch→kick cancel string (see the combo block above).
      if (this.comboP > 0 && this.rng.random() < this.comboP) {
        this.comboAt = this.t + ctx.ownAttacks.punch.cancelInto.kick + 0.04;
        this.comboUntil = this.comboAt + 0.15;
      }
      return { ...this.current, punch: true };
    } else if (r < pPunch + pKick) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      return { ...this.current, kick: true };
    } else if (r < pPunch + pKick + 0.15) {
      // Optionally arm a bait: start a punch, then cancel into block next tick.
      if (this.rng.random() < effBaitP) {
        this.baitArmed = true;
        this.baitStartedAt = this.t;
        this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
        return { ...this.current, punch: true };
      }
      this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
    } else if (r < pPunch + pKick + 0.15 + 0.15) {
      // Fixed 15% retreat share; whatever probability the low rungs don't
      // spend on attacking becomes idle time — a level-1 president mostly
      // stands there being punchable.
      this.current = { move: -1, side: 0, punch: false, kick: false, block: false };
    } else {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
    }
    this.baitArmed = false;
    return { ...this.current };
  }

  dispose() {}
}