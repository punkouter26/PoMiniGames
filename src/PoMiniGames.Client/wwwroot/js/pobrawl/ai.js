// ai.js — CPU fighter. Emits the same intent shape as KeyboardController so the game
// treats human and CPU fighters identically. Simple state machine: approach when out of
// range, weighted attack/block/retreat choices in range, reactive block against windups,
// and a brief retreat after eating quick consecutive hits so it doesn't look stunlocked.

const REACTION_MS = { easy: 450, medium: 300, hard: 180 };
const BLOCK_REACT_P = { easy: 0.2, medium: 0.45, hard: 0.7 };

export class AiController {
  constructor(difficulty, rng = null) {
    this.reactionMs = REACTION_MS[difficulty] || REACTION_MS.medium;
    this.blockP = BLOCK_REACT_P[difficulty] || BLOCK_REACT_P.medium;
    this.rng = rng || { random: Math.random };
    this.sinceDecision = 1e9;
    this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
    this.retreatUntil = 0;
    this.recentHits = [];
    this.t = 0;
  }

  /** Called by the game when this fighter takes a hit, for the anti-stunlock retreat. */
  notifyHit() {
    this.recentHits.push(this.t);
    this.recentHits = this.recentHits.filter((h) => this.t - h < 1.5);
    if (this.recentHits.length >= 2) this.retreatUntil = this.t + 0.7;
  }

  /** ctx: { dt, distance, kickRange, opponentWindup } */
  update(ctx) {
    this.t += ctx.dt;
    this.sinceDecision += ctx.dt * 1000;

    // One-shot flags are consumed every read; keep holds (move/block) between decisions.
    const intent = { ...this.current, punch: false, kick: false, side: 0 };

    // Reactive block outranks the decision clock — that's the "reaction" being modelled.
    if (ctx.opponentWindup && ctx.distance < ctx.kickRange * 1.2 && !this.current.block) {
      if (this.rng.random() < this.blockP) {
        this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
        this.sinceDecision = 0;
        return { ...this.current };
      }
    }

    if (this.sinceDecision < this.reactionMs) return intent;
    this.sinceDecision = 0;

    if (this.t < this.retreatUntil) {
      this.current = { move: -1, side: 0, punch: false, kick: false, block: false };
      return { ...this.current };
    }

    if (ctx.distance > ctx.kickRange) {
      const side = this.rng.random() < 0.15 ? (this.rng.random() < 0.5 ? 1 : -1) : 0;
      this.current = { move: 1, side: 0, punch: false, kick: false, block: false };
      return { ...this.current, side };
    }

    const r = this.rng.random();
    if (r < 0.35) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      return { ...this.current, punch: true };
    } else if (r < 0.6) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      return { ...this.current, kick: true };
    } else if (r < 0.75) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
    } else if (r < 0.9) {
      this.current = { move: -1, side: 0, punch: false, kick: false, block: false };
    } else {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
    }
    return { ...this.current };
  }

  dispose() {}
}
