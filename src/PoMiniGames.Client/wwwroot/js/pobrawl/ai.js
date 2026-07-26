// ai.js — CPU fighter. Emits the same intent shape as KeyboardController so the game
// treats human and CPU fighters identically.

import { PERSONALITIES } from './personalities.js';
//
// Frame-data awareness: the AI receives the opponent's current attack phase
// (windup/active/recover) and the recovery window of each of its own attacks.
// It will:
//   • block during opponent windup with probability by difficulty (reactive defense)
//   • throw its fastest attack when the opponent is in active/recover (whiff punish)
//   • occasionally commit to a blocked attack then cancel into block (bait)
//   • back off after taking quick consecutive hits (anti-stunlock)
//   • occasionally wind up a held CHARGE attack while the opponent is stuck
//     in hitstun (the coil pose is the player's tell to block the release)
//
// In-match adaptation: the AI also reads the opponent's habits over a rolling
// ~8-second window and shifts its weights —
//   • turtles (blocking a big share of in-range time) draw more kicks, because
//     the guard capsules only cover the forearms so kicks to the legs land
//     through a standing block, plus more feint-baits
//   • spammers (high attack rate) get blocked and whiff-punished more often
// Adaptation strength scales with the rung, so a level-2 president barely
// adjusts while a level-9 one counters your gameplan within a few exchanges.

// Fifteen numeric skill rungs for the 1-player presidents ladder. Level 1 is a
// pushover (sluggish, near-blind defense, rarely swings); level 15 is a wall
// (superhuman reactions, near-perfect blocking and whiff punishing, relentless).
// `aggro` scales how often the AI chooses to attack at all. `comboP` is the
// chance a committed punch is pre-planned as a punch→kick cancel string —
// only rungs 7+ know the cancel table exists. The top five rungs (LBJ-FDR)
// tighten reactions past human reflexes and lean on more baits and combos
// rather than just faster reads — diminishing returns on raw reactionMs.
const LEVELS = [
  /*  1 */ { reactionMs: 780, blockP: 0.03, baitP: 0.00, punishP: 0.02, aggro: 0.35, comboP: 0.00 },
  /*  2 */ { reactionMs: 640, blockP: 0.08, baitP: 0.00, punishP: 0.06, aggro: 0.50, comboP: 0.00 },
  /*  3 */ { reactionMs: 540, blockP: 0.15, baitP: 0.00, punishP: 0.12, aggro: 0.62, comboP: 0.00 },
  /*  4 */ { reactionMs: 460, blockP: 0.24, baitP: 0.02, punishP: 0.22, aggro: 0.74, comboP: 0.00 },
  /*  5 */ { reactionMs: 380, blockP: 0.34, baitP: 0.04, punishP: 0.34, aggro: 0.85, comboP: 0.00 },
  /*  6 */ { reactionMs: 320, blockP: 0.45, baitP: 0.06, punishP: 0.46, aggro: 0.95, comboP: 0.00 },
  /*  7 */ { reactionMs: 270, blockP: 0.56, baitP: 0.08, punishP: 0.58, aggro: 1.05, comboP: 0.25 },
  /*  8 */ { reactionMs: 225, blockP: 0.66, baitP: 0.10, punishP: 0.70, aggro: 1.12, comboP: 0.35 },
  /*  9 */ { reactionMs: 185, blockP: 0.76, baitP: 0.13, punishP: 0.80, aggro: 1.20, comboP: 0.45 },
  /* 10 */ { reactionMs: 150, blockP: 0.86, baitP: 0.16, punishP: 0.90, aggro: 1.28, comboP: 0.55 },
  /* 11 */ { reactionMs: 130, blockP: 0.90, baitP: 0.19, punishP: 0.94, aggro: 1.32, comboP: 0.62 },
  /* 12 */ { reactionMs: 118, blockP: 0.92, baitP: 0.21, punishP: 0.96, aggro: 1.36, comboP: 0.68 },
  /* 13 */ { reactionMs: 108, blockP: 0.94, baitP: 0.23, punishP: 0.98, aggro: 1.40, comboP: 0.74 },
  /* 14 */ { reactionMs: 100, blockP: 0.96, baitP: 0.25, punishP: 0.99, aggro: 1.43, comboP: 0.80 },
  /* 15 */ { reactionMs: 95,  blockP: 0.97, baitP: 0.27, punishP: 1.00, aggro: 1.46, comboP: 0.86 },
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
    // How hard the habit reads bend the weights: level 1 ≈ 0.07, level 15 = 1.
    this.adapt = level / MAX_RUNG;

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
    this.chargeP = Math.min(0.6, 0.14 + 0.06 * level);
    // Optional cooldown-timer fields for personality-driven AI cadences:
    //   bidenChargeReadyAt — wall-clock time the next Biden charge swing is allowed
    //   obamaComboReadyAt  — wall-clock time the next Obama punch+kick string is fired
    // The engine sets t=0 at fight start; they're per-AI-instance.
    this.bidenChargeReadyAt = 0;
    this.obamaComboReadyAt = 0;
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

    // ── Personality cadences ────────────────────────────────────────
    // Biden "The Big Guy": every ~5.5 s a charged biden commits a heavy
    // charge-up (realized as the AI holding punch/kick for 1.0 s). The engine
    // honors the chargeWindupMul by scaling the visible coil duration.
    if (this.charId === 'biden' && PERSONALITIES.biden?.chargeEverySecs
        && this.t >= this.bidenChargeReadyAt
        && ctx.distance < ctx.kickRange * 1.2) {
      const cfg = PERSONALITIES.biden;
      this.holdName = this.rng.random() < 0.5 ? 'kick' : 'punch';
      this.holdUntil = this.t + (cfg.chargeHoldSecs || 1.0);
      this.bidenChargeReadyAt = this.t + (cfg.chargeEverySecs || 5.5);
      this.baitArmed = false;
      this.comboAt = 0;
      this.comboUntil = 0;
      const out = { move: 0, side: 0, punch: false, kick: false, block: false };
      out[this.holdName] = true;
      out[this.holdName + 'Held'] = true;
      return out;
    }

    // Obama "No-Drama Open" / "Drone Strike": every ~4 s commit to a
    // pre-planned punch→kick string. The existing comboAt/comboUntil fields
    // already implement this for rungs 7+, so we just commit to a punch and
    // arm the combo. Lower-level Obama (rung <= 6) is missing the cancel
    // table — we emulate by re-arming comboAt/comboUntil directly.
    if (this.charId === 'obama' && PERSONALITIES.obama?.comboEverySecs
        && this.t >= this.obamaComboReadyAt
        && ctx.distance < ctx.kickRange * 1.2) {
      this.comboAt = this.t + ctx.ownAttacks.punch.cancelInto.kick + 0.04;
      this.comboUntil = this.comboAt + 0.15;
      this.obamaComboReadyAt = this.t + (PERSONALITIES.obama.comboEverySecs || 4);
      const out = { move: 0, side: 0, punch: true, kick: false, block: false };
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.sinceDecision = 0;
      return out;
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

    // ── Pre-planned cancel string (rungs 7+) ────────────────────────────
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