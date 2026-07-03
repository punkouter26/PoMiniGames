// rng.js — Mulberry32 seeded PRNG for deterministic randomness.
// Wave seeds + enemy spawn jitter use this so a fixed daily seed produces
// the same playfield (see Feature #6 in the design doc). Pure math, no deps.

/**
 * @param {number} seed
 * @returns {{ next: () => number, range: (lo:number, hi:number) => number, int: (lo:number, hi:number) => number, pick: <T>(arr:T[]) => T }}
 */
export function makeRng(seed = 0xC0FFEE) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}
