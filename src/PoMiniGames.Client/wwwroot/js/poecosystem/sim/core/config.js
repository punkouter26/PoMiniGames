// config.js — every tunable number in the PoEcosystem simulation lives here.
//
// The sim is deterministic per seed (SPEC §13 criterion 4), so changing any value in
// this file changes every world; the population tuning at plan checkpoint CP-C happens
// here and nowhere else.

// ── Time ─────────────────────────────────────────────────────────────────
export const TICK_SECONDS = 0.05;          // fixed sim step (20 Hz)
export const MAX_STEPS_PER_TICK = 4;       // accumulator cap: a hidden tab never bursts on return
export const YEAR_SECONDS = 30;            // creature ages are displayed in years
export const DAY_SECONDS = 120;            // cosmetic light cycle, not tied to years
export const DAYS_PER_YEAR = 10;           // calendar days shown in the HUD clock (Year N · Day D)
export const SPEEDS = Object.freeze([0, 1, 2, 4]);

// ── World ────────────────────────────────────────────────────────────────
export const WORLD_SIZE = 200;             // tiles per side; 1 tile = 1 m
export const CREATURE_CAP = 400;
export const LOW_END_CREATURE_CAP = 250;
export const PROP_CAP = 256;               // ragdoll parts + logs + rocks + projectiles in flight

// ── Personality ──────────────────────────────────────────────────────────
export const TRAITS = Object.freeze(['boldness', 'sociability', 'curiosity', 'greed', 'diligence']);
export const TRAIT_MUTATION_SIGMA = 0.08;  // offspring = mean(parents) + N(0, sigma), clamped [0,1]
export const NUDGE = Object.freeze({ maxDelta: 0.25, decaySeconds: 60 });

// ── Seeded PRNG streams (SPEC / plan decision 4) ─────────────────────────
// One independent stream per subsystem so adding a cosmetic draw never shifts a
// population outcome. Salts are arbitrary distinct constants.
export const RNG_SALT = Object.freeze({
  terrain: 0x1f3d5b79,
  genetics: 0x2c4e6a8b,
  behavior: 0x3d5f7c9d,
  events: 0x4e6a8dbf,
  names: 0x5f7b9ed1,
  cosmetic: 0x6a8cafe3,
});

// ── Physics props (frame propKind = kind * 8 + sizeIndex) ────────────────
export const PROP_KIND = Object.freeze({ ragdollPart: 0, log: 1, rock: 2, projectile: 3 });
export const PROP_SIZES = Object.freeze([
  [0.30, 0.20, 0.45], // 0 small quadruped torso
  [0.18, 0.18, 0.18], // 1 head / small part
  [0.10, 0.28, 0.10], // 2 leg / limb
  [0.55, 0.35, 0.90], // 3 large quadruped torso
  [0.40, 0.55, 0.28], // 4 human chest
  [0.30, 2.60, 0.30], // 5 log
  [0.60, 0.60, 0.60], // 6 rock
  [1.00, 1.00, 1.00], // 7 boulder
]);

// ── External modules (workers have no import map; see plan decision 2) ───
export const CANNON_CDN_URL = 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

// ── Flora (SPEC §7.6) ────────────────────────────────────────────────────
export const FLORA = Object.freeze({
  grassInit: Object.freeze({ grass: 0.8, forest: 0.5, hill: 0.4 }),
  // Logistic regrowth rate per second, db/dt = r·(b + seed)·(1 − b); the seed term lets a
  // grazed-bare or burnt tile recover instead of staying at zero forever.
  grassRate: Object.freeze({ grass: 0.04, forest: 0.025, hill: 0.012 }),
  grassSeed: 0.03,
  maxBushes: 300,
  bushChance: 0.25,          // per forest-edge tile, in index order, until the cap
  bushRipenSeconds: 40,
  bushFoodValue: 0.3,        // hunger removed by one stripped bush
  treeDensity: 0.35,         // fraction of forest tiles carrying a tree
  treeRegrowSeconds: 180,    // stump → standing
  treeBurnRegrowMultiplier: 2,
  logsPerTree: 3,
});

// ── Behaviour (SPEC §7.5) ────────────────────────────────────────────────
export const MEMORY = Object.freeze({ foodSeconds: 120, waterSeconds: 240 });
export const BEHAVIOR = Object.freeze({
  spatialCell: 8,            // metres per spatial-hash cell (max perception 25 m = 4 cells)
  goalHysteresis: 0.05,      // a new goal must beat the current one by this much
  rescoreEveryTicks: 5,      // goals re-evaluated every N ticks, staggered by index
  wanderTurn: 0.6,           // radians of yaw jitter per wander step
});
