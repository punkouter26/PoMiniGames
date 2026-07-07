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

// Ten numeric skill rungs for the 1-player presidents ladder. Level 1 is a
// pushover (sluggish, near-blind defense, rarely swings); level 10 is a wall
// (snap reactions, near-perfect blocking and whiff punishing, aggressive).
// `aggro` scales how often the AI chooses to attack at all.
const LEVELS = [
  /* 1 */ { reactionMs: 780, blockP: 0.03, baitP: 0.00, punishP: 0.02, aggro: 0.35 },
  /* 2 */ { reactionMs: 640, blockP: 0.08, baitP: 0.00, punishP: 0.06, aggro: 0.50 },
  /* 3 */ { reactionMs: 540, blockP: 0.15, baitP: 0.00, punishP: 0.12, aggro: 0.62 },
  /* 4 */ { reactionMs: 460, blockP: 0.24, baitP: 0.02, punishP: 0.22, aggro: 0.74 },
  /* 5 */ { reactionMs: 380, blockP: 0.34, baitP: 0.04, punishP: 0.34, aggro: 0.85 },
  /* 6 */ { reactionMs: 320, blockP: 0.45, baitP: 0.06, punishP: 0.46, aggro: 0.95 },
  /* 7 */ { reactionMs: 270, blockP: 0.56, baitP: 0.08, punishP: 0.58, aggro: 1.05 },
  /* 8 */ { reactionMs: 225, blockP: 0.66, baitP: 0.10, punishP: 0.70, aggro: 1.12 },
  /* 9 */ { reactionMs: 185, blockP: 0.76, baitP: 0.13, punishP: 0.80, aggro: 1.20 },
  /* 10 */{ reactionMs: 150, blockP: 0.86, baitP: 0.16, punishP: 0.90, aggro: 1.28 },
];

// Legacy string difficulties (used by demo / 2p fallbacks) map onto rungs.
const NAMED_LEVELS = { easy: 2, medium: 5, hard: 8 };

export class AiController {
  /** difficulty: 1-10 rung number, or 'easy' | 'medium' | 'hard'. */
  constructor(difficulty, rng = null) {
    const level = typeof difficulty === 'number'
      ? Math.max(1, Math.min(10, Math.round(difficulty)))
      : (NAMED_LEVELS[difficulty] || NAMED_LEVELS.medium);
    const p = LEVELS[level - 1];
    this.reactionMs = p.reactionMs;
    this.blockP = p.blockP;
    this.baitP = p.baitP;
    this.punishP = p.punishP;
    this.aggro = p.aggro;
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

    // Attack shares scale with the rung's aggression; the leftover probability
    // shifts into block/retreat/wait, so low rungs mostly shuffle around.
    const r = this.rng.random();
    const pPunch = 0.35 * this.aggro;
    const pKick = 0.25 * this.aggro;
    if (r < pPunch) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      return { ...this.current, punch: true };
    } else if (r < pPunch + pKick) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      return { ...this.current, kick: true };
    } else if (r < pPunch + pKick + 0.15) {
      // Optionally arm a bait: start a punch, then cancel into block next tick.
      if (this.rng.random() < this.baitP) {
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