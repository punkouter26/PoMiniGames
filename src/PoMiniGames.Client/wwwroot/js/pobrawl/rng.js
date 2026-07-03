// rng.js — deterministic seeded PRNG.
// Adapted from GameBlocks (github.com/xt4d/GameBlocks, MIT) math/RandomUtils.js.
// A seeded generator makes demo mode and hit variance reproducible: the same seed
// replays the same fight, which is what a kiosk/demo loop wants.

export class RandomGenerator {
  constructor(seed = 42) {
    this.seed(seed);
  }

  seed(seed = 42) {
    this.state = seed >>> 0;
    return this;
  }

  random() {
    this.state += 0x6d2b79f5;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(min, max) {
    return min + (max - min) * this.random();
  }

  randint(min, max) {
    return Math.floor(this.uniform(min, max + 1));
  }

  choice(items) {
    return items[Math.floor(this.random() * items.length)];
  }

  // Fisher-Yates shuffle using this generator (returns a new array).
  shuffle(items) {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
