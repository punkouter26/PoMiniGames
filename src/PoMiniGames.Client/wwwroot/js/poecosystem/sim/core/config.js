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
  alertTicks: 120,           // 6 s: how long a herd alarm keeps neighbours fleeing
  orphanHungerMultiplier: 1.5,
  herdRadius: 12,
  packRadius: 12,
  bedsPerHut: 4,
  hutSiteRadius: 6,          // new huts stay within this many tiles of the first hut
  firstHutWaterRadius: 4,    // the first hut is placed on grass within this many tiles of water
});

// ── World composition (SPEC §7.2 start population, §7.5/7.7 interaction rules) ──
export const POPULATION = Object.freeze({ rabbits: 40, deer: 20, wolves: 6, humans: 8, huts: 3, initialAgeFraction: 0.6 });
export const WORLD = Object.freeze({
  grazeRate: 0.4,            // biomass (= hunger) per second while eating grass
  drinkRate: 0.5,            // thirst per second while drinking
  foodBiomassMin: 0.15,      // a tile counts as food above this biomass
  foodScanTiles: 5,          // half-size of the square scanned for grass/bushes
  treeScanTiles: 12,         // half-size of the square humans scan for a standing tree
  carcassSeconds: 60,
  carcassFoodFraction: 0.5,  // food left on a carcass after the kill is eaten
  chopSeconds: 3,
  reachPadding: 0.4,         // metres added to the radii for a bite/kill
  interactDistance: 1.5,     // metres to eat a bush/carcass, drink, mate, enter a hut
  fullLogCooldownSeconds: 60,
  popSampleTicks: 20,        // one population sample per second
  popHistoryMax: 1800,       // 30 minutes of samples
  birthOffset: 1.0,          // metres offspring spawn from the mother
});

// ── Physics (SPEC §7.7). Cosmetic only: no rule reads a body. ───────────
export const PHYSICS = Object.freeze({
  gravity: 9.81,
  substeps: 2,               // cannon steps per sim tick (1 on low-end devices)
  solverIterations: 10,
  maxActiveRagdolls: 16,     // ≈100 bodies; beyond this a death lies down statically
  ragdollMaxSeconds: 8,      // a ragdoll is frozen into a carcass by then at the latest
  carcassSeconds: 60,        // frozen carcass parts stay this long
  logSeconds: 300,           // a settled log stays this long
  rockSeconds: 120,          // a settled rock stays this long (SPEC: obstacle for 120 s)
  settleTimeoutSeconds: 15,  // rocks/logs are frozen by then even if still twitching
  treeHingeSeconds: 1,       // the trunk swings on its stump this long before breaking free
  sleepSpeedLimit: 0.2,
  sleepTimeLimit: 0.5,
  linearDamping: 0.08,
  angularDamping: 0.25,
  friction: 0.6,
  restitution: 0.15,
});
