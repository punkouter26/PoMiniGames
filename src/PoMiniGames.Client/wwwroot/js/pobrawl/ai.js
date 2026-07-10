// ai.js — CPU fighter. Emits the same intent shape as KeyboardController so the game
// treats human and CPU fighters identically.
//
// Frame-data awareness: the AI receives the opponent's current attack phase
// (windup/active/recover) and the recovery window of each of its own attacks.
// It will:
//   • block during opponent windup with probability by difficulty (reactive defense)
//   • throw its fastest attack when the opponent is in active/recover (whiff punish)
//   • occasionally commit to a blocked attack then cancel into block (bait)
//   • back off after taking quick consecutive hits (anti-stunlock)
//
// In-match adaptation: the AI also reads the opponent's habits over a rolling
// ~8-second window and shifts its weights —
//   • turtles (blocking a big share of in-range time) draw more kicks, because
//     the guard capsules only cover the forearms so kicks to the legs land
//     through a standing block, plus more feint-baits
//   • spammers (high attack rate) get blocked and whiff-punished more often
// Adaptation strength scales with the rung, so a level-2 president barely
// adjusts while a level-9 one counters your gameplan within a few exchanges.

// Ten numeric skill rungs for the 1-player presidents ladder. Level 1 is a
// pushover (sluggish, near-blind defense, rarely swings); level 10 is a wall
// (snap reactions, near-perfect blocking and whiff punishing, aggressive).
// `aggro` scales how often the AI chooses to attack at all. `comboP` is the
// chance a committed punch is pre-planned as a punch→kick cancel string —
// only rungs 7+ know the cancel table exists.
const LEVELS = [
  /* 1 */ { reactionMs: 780, blockP: 0.03, baitP: 0.00, punishP: 0.02, aggro: 0.35, comboP: 0.00 },
  /* 2 */ { reactionMs: 640, blockP: 0.08, baitP: 0.00, punishP: 0.06, aggro: 0.50, comboP: 0.00 },
  /* 3 */ { reactionMs: 540, blockP: 0.15, baitP: 0.00, punishP: 0.12, aggro: 0.62, comboP: 0.00 },
  /* 4 */ { reactionMs: 460, blockP: 0.24, baitP: 0.02, punishP: 0.22, aggro: 0.74, comboP: 0.00 },
  /* 5 */ { reactionMs: 380, blockP: 0.34, baitP: 0.04, punishP: 0.34, aggro: 0.85, comboP: 0.00 },
  /* 6 */ { reactionMs: 320, blockP: 0.45, baitP: 0.06, punishP: 0.46, aggro: 0.95, comboP: 0.00 },
  /* 7 */ { reactionMs: 270, blockP: 0.56, baitP: 0.08, punishP: 0.58, aggro: 1.05, comboP: 0.25 },
  /* 8 */ { reactionMs: 225, blockP: 0.66, baitP: 0.10, punishP: 0.70, aggro: 1.12, comboP: 0.35 },
  /* 9 */ { reactionMs: 185, blockP: 0.76, baitP: 0.13, punishP: 0.80, aggro: 1.20, comboP: 0.45 },
  /* 10 */{ reactionMs: 150, blockP: 0.86, baitP: 0.16, punishP: 0.90, aggro: 1.28, comboP: 0.55 },
];

// Habit-tracker tuning. The rolling window is an exponential decay so recent
// behavior dominates; thresholds are the point past which a habit is "read".
const HABIT_TAU = 8;          // seconds of memory
const TURTLE_THRESHOLD = 0.35; // fraction of in-range time spent blocking
const SPAM_THRESHOLD = 0.5;    // opponent attacks per second

// Legacy string difficulties (used by demo / 2p fallbacks) map onto rungs.
const NAMED_LEVELS = { easy: 2, medium: 5, hard: 8 };

export class AiController {
  /** difficulty: 1-10 rung number, or 'easy' | 'medium' | 'hard'. */
  constructor(difficulty, rng = null) {
    const level = typeof difficulty === 'number'
      ? Math.max(1, Math.min(10, Math.round(difficulty)))
      : (NAMED_LEVELS[difficulty] || NAMED_LEVELS.medium);
    const p = LEVELS[level - 1];
    this.level = level;
    this.reactionMs = p.reactionMs;
    this.blockP = p.blockP;
    this.baitP = p.baitP;
    this.punishP = p.punishP;
    this.aggro = p.aggro;
    this.comboP = p.comboP;
    // How hard the habit reads bend the weights: level 1 ≈ 0.1, level 10 = 1.
    this.adapt = level / 10;
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
    this.chargeP = Math.min(0.5, 0.08 + 0.045 * level);
    // Pre-planned punch→kick cancel string (rungs 7+): fire the kick edge when
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
  }

  /**
   * ctx shape (extended by the engine):
   *   { dt, distance, kickRange,
   *     opponentState, opponentStateT,           // 'punch'|'kick'|'hitstun'|...
   *     opponentWindup, opponentActive, opponentRecover, // booleans this tick
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
    if (ctx.opponentWindup && !this.prevOppWindup) this.oppAtkN += 1;
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

    // ── Active charge hold ──────────────────────────────────────────────
    // A charge plan overrides everything: keep the button held until the
    // release time, then drop the held flag so the engine throws the strike.
    if (this.holdName) {
      if (this.t < this.holdUntil) {
        const out = { move: 0, side: 0, punch: false, kick: false, block: false };
        out[this.holdName + 'Held'] = true;
        return out;
      }
      this.holdName = null;
      this.sinceDecision = 0;
      return { move: 0, side: 0, punch: false, kick: false, block: false };
    }

    // ── Pre-planned cancel string (rungs 7+) ────────────────────────────
    // A punch committed with a combo plan cancels into kick exactly when the
    // frame-data window opens. Fires outside the reaction gate — the string
    // was decided when the punch started, not as a reaction.
    if (this.comboAt > 0 && this.t >= this.comboAt) {
      const missed = this.t > this.comboUntil
        || ctx.opponentState === 'down' || ctx.opponentState === 'getup'
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
    // Block during the opponent's windup if we can plausibly get there.
    if (ctx.opponentWindup && ctx.distance < ctx.kickRange * 1.25 && !this.current.block) {
      if (this.rng.random() < effBlockP) {
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

    // ── Downed opponent: back off ───────────────────────────────────────
    // The body is invulnerable while down/getting up — swinging at it wastes
    // frames and looks dumb. Give ground and reset spacing instead.
    if (ctx.opponentState === 'down' || ctx.opponentState === 'getup') {
      this.current = { move: ctx.distance < 2.2 ? -1 : 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      return { ...this.current };
    }

    // ── Anti-stunlock retreat ───────────────────────────────────────────
    if (this.t < this.retreatUntil) {
      this.current = { move: -1, side: 0, punch: false, kick: false, block: false };
      return { ...this.current };
    }

    // ── Charged attack: wind up while the opponent can't answer ────────
    // The opponent is stuck in hitstun and in range — occasionally commit to
    // a held charge instead of a tap. The visible coil is the player's cue
    // to block or interrupt when the stun wears off.
    if (ctx.opponentState === 'hitstun' && ctx.distance < ctx.kickRange
        && this.rng.random() < this.chargeP) {
      const name = this.rng.random() < 0.45 ? 'kick' : 'punch';
      this.holdName = name;
      this.holdUntil = this.t + 0.45 + this.rng.random() * 0.5;
      this.baitArmed = false;
      this.comboAt = 0;
      this.comboUntil = 0;
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      const out = { ...this.current };
      out[name] = true;            // press edge starts the charge
      out[name + 'Held'] = true;   // and the hold keeps it winding
      return out;
    }

    // ── Out of range: approach, occasionally sidestep ───────────────────
    if (ctx.distance > ctx.kickRange) {
      const side = this.rng.random() < 0.18 ? (this.rng.random() < 0.5 ? 1 : -1) : 0;
      this.current = { move: 1, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      return { ...this.current, side };
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
      // Rungs 7+ sometimes commit to the punch as the opener of a
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