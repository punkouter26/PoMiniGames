// ai.js — client-side rival typists for local 1P races and demo mode.
//
// An AI lane "types" its sequence at a difficulty-tuned cadence with a wrong-key
// rate, and jumps hurdles with a reaction-jittered lookahead. It drives the SAME
// SequenceTracker/physics path a human lane uses — the AI has no shortcut into the
// stride model, so difficulty is purely cadence + accuracy.
//
// (The server has its own medium-difficulty twin in PoSportsSim.DriveAi for online
// races; this one exists so local modes work fully offline.)
import { HURDLE_POSITIONS } from './physics.js';

export const DIFFICULTIES = {
  easy: { keysPerSecond: 3.2, errorRate: 0.08, jumpLookahead: 1.2, jumpJitter: 0.5 },
  medium: { keysPerSecond: 4.5, errorRate: 0.05, jumpLookahead: 1.6, jumpJitter: 0.3 },
  hard: { keysPerSecond: 6.0, errorRate: 0.02, jumpLookahead: 2.0, jumpJitter: 0.15 },
};

/** Mulberry32 — tiny seeded PRNG so demo races are deterministic per seed. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class AiTypist {
  /**
   * @param {'easy'|'medium'|'hard'} difficulty
   * @param {number} seed per-lane seed for deterministic demo runs
   */
  constructor(difficulty, seed) {
    this.cfg = DIFFICULTIES[difficulty] ?? DIFFICULTIES.medium;
    this.rng = makeRng(seed);
    this.keyTimer = this.gap();
    this.jumpArmed = true;
  }

  gap() {
    // Jittered inter-key gap around the target cadence (±20%).
    return (1 / this.cfg.keysPerSecond) * (0.8 + 0.4 * this.rng());
  }

  /**
   * Advance the typist. Calls back into the lane's controls exactly like a human:
   * `seqStep(step)` with the ordinal it meant to press (possibly wrong), `jump()`.
   * @param {number} dt seconds
   * @param {{position:number, airborne:number, seqProgress:number, onHurdlesLeg:boolean}} lane
   * @param {{seqStep:(s:number)=>void, jump:()=>void}} controls
   */
  update(dt, lane, controls) {
    // Hurdle decision: jump when the next hurdle enters the (jittered) lookahead.
    if (lane.onHurdlesLeg && lane.airborne <= 0) {
      const next = HURDLE_POSITIONS.find((h) => h > lane.position);
      if (next !== undefined) {
        const window = this.cfg.jumpLookahead * (1 - this.cfg.jumpJitter * this.rng());
        if (next - lane.position <= window) {
          if (this.jumpArmed) { controls.jump(); this.jumpArmed = false; }
        } else {
          this.jumpArmed = true;
        }
      }
    } else if (lane.airborne <= 0) {
      this.jumpArmed = true;
    }

    this.keyTimer -= dt;
    if (this.keyTimer > 0) return;
    this.keyTimer = this.gap();
    const step = this.rng() < this.cfg.errorRate
      ? Math.floor(this.rng() * 4)  // fat-finger — may still be right by luck
      : lane.seqProgress;           // the correct next key
    controls.seqStep(step);
  }
}
