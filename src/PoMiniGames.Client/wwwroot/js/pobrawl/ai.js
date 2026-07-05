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

const REACTION_MS = { easy: 480, medium: 320, hard: 200 };
const BLOCK_REACT_P = { easy: 0.22, medium: 0.5, hard: 0.78 };
const BAIT_P = { easy: 0.0, medium: 0.06, hard: 0.12 };
const PUNISH_P = { easy: 0.1, medium: 0.5, hard: 0.82 };

export class AiController {
  constructor(difficulty, rng = null) {
    this.reactionMs = REACTION_MS[difficulty] || REACTION_MS.medium;
    this.blockP = BLOCK_REACT_P[difficulty] || BLOCK_REACT_P.medium;
    this.baitP = BAIT_P[difficulty] || BAIT_P.medium;
    this.punishP = PUNISH_P[difficulty] || PUNISH_P.medium;
    this.rng = rng || { random: Math.random };
    this.sinceDecision = 1e9;
    this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
    this.retreatUntil = 0;
    this.recentHits = [];
    this.t = 0;
    // Used to occasionally start a swing then cancel to block on the next decision.
    this.baitArmed = false;
    this.baitStartedAt = 0;
  }

  notifyHit() {
    this.recentHits.push(this.t);
    this.recentHits = this.recentHits.filter((h) => this.t - h < 1.5);
    if (this.recentHits.length >= 2) this.retreatUntil = this.t + 0.7;
  }

  /**
   * ctx shape (extended by the engine):
   *   { dt, distance, kickRange,
   *     opponentState, opponentStateT,           // 'punch'|'kick'|'hitstun'|...
   *     opponentWindup, opponentActive, opponentRecover, // booleans this tick
   *     ownAttacks: { punch: {...}, kick: {...} } // with windup/active/recover
   *   }
   */
  update(ctx) {
    this.t += ctx.dt;
    this.sinceDecision += ctx.dt * 1000;

    // Edge-triggered flags are consumed each read; holds (move/block) persist.
    const intent = { ...this.current, punch: false, kick: false, side: 0 };

    // ── Reactive defense ────────────────────────────────────────────────
    // Block during the opponent's windup if we can plausibly get there.
    if (ctx.opponentWindup && ctx.distance < ctx.kickRange * 1.25 && !this.current.block) {
      if (this.rng.random() < this.blockP) {
        this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
        this.sinceDecision = 0;
        this.baitArmed = false;
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

    if ((ctx.opponentActive || ctx.opponentRecover) && this.rng.random() < this.punishP) {
      // Punch is the fastest move — best for punishing recovery.
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      return { ...this.current, punch: true };
    }

    const r = this.rng.random();
    if (r < 0.35) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      return { ...this.current, punch: true };
    } else if (r < 0.6) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      return { ...this.current, kick: true };
    } else if (r < 0.75) {
      // Optionally arm a bait: start a punch, then cancel into block next tick.
      if (this.rng.random() < this.baitP) {
        this.baitArmed = true;
        this.baitStartedAt = this.t;
        this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
        return { ...this.current, punch: true };
      }
      this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
    } else if (r < 0.9) {
      this.current = { move: -1, side: 0, punch: false, kick: false, block: false };
    } else {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
    }
    this.baitArmed = false;
    return { ...this.current };
  }

  dispose() {}
}