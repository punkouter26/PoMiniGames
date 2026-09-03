import { describe, expect, it } from 'vitest';
import { createSpatialHash } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/spatial.js';
import { MEMORY_KIND, forget, recall, remember } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/behavior/memory.js';
import { fleeFrom, moveCreature, seekTo, wander } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/behavior/steering.js';
import { GOAL, chooseGoal, scoreGoals } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/behavior/utility.js';
import { createEntities, NONE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/entities.js';
import { createRng } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/prng.js';
import { spawnCreature } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/lifecycle.js';
import { SPECIES, SPECIES_ID } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/species.js';
import { TRAIT } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/traits.js';
import { generateIsland } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/island.js';
import { TILE, isWalkable, tileIndex, tileX, tileZ } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/tiles.js';
import { MEMORY, TICK_SECONDS, TRAITS, WORLD_SIZE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

const terrain = generateIsland(6);
const tileState = new Uint8Array(terrain.size * terrain.size);
const walkableTile = () => { for (let i = 20 * terrain.size; i < terrain.type.length; i++) if (terrain.type[i] === TILE.GRASS) return i; return -1; };

describe('spatial hash', () => {
  it('returns exactly the brute-force neighbour set for any radius', () => {
    const rng = createRng(21);
    const e = createEntities(300);
    for (let k = 0; k < 300; k++) spawnCreature(e, { speciesId: k % 4, x: rng.range(0, WORLD_SIZE), z: rng.range(0, WORLD_SIZE), tick: 0 });
    for (let k = 0; k < 300; k += 7) e.free(k);
    const hash = createSpatialHash(WORLD_SIZE);
    hash.rebuild(e);
    for (const r of [3, 8, 12.5, 25, 60]) {
      for (let q = 0; q < 10; q++) {
        const qx = rng.range(0, WORLD_SIZE); const qz = rng.range(0, WORLD_SIZE);
        const got = new Set();
        hash.forEachInRadius(qx, qz, r, (i, d2) => { expect(d2).toBeLessThanOrEqual(r * r + 1e-6); got.add(i); });
        const want = new Set();
        e.forEachAlive(i => { const dx = e.x[i] - qx; const dz = e.z[i] - qz; if (dx * dx + dz * dz <= r * r) want.add(i); });
        expect([...got].sort((a, b) => a - b)).toEqual([...want].sort((a, b) => a - b));
      }
    }
    hash.rebuild(e);
    expect(hash.count).toBe(e.count);
  });
});

describe('memory', () => {
  it('remembers food and water separately, recalls within the decay window, forgets after', () => {
    const e = createEntities(2);
    const i = spawnCreature(e, { speciesId: 0, x: 0, z: 0, tick: 0 });
    expect(recall(e, i, MEMORY_KIND.FOOD, 0)).toBe(NONE);
    remember(e, i, MEMORY_KIND.FOOD, 1234, 100);
    remember(e, i, MEMORY_KIND.WATER, 777, 100);
    expect(recall(e, i, MEMORY_KIND.FOOD, 100)).toBe(1234);
    expect(recall(e, i, MEMORY_KIND.WATER, 100)).toBe(777);
    const foodTicks = Math.round(MEMORY.foodSeconds / TICK_SECONDS);
    expect(recall(e, i, MEMORY_KIND.FOOD, 100 + foodTicks - 1)).toBe(1234);
    expect(recall(e, i, MEMORY_KIND.FOOD, 100 + foodTicks + 1)).toBe(NONE);
    expect(recall(e, i, MEMORY_KIND.WATER, 100 + foodTicks + 1)).toBe(777);
    forget(e, i, MEMORY_KIND.WATER);
    expect(recall(e, i, MEMORY_KIND.WATER, 101)).toBe(NONE);
  });
});

describe('steering', () => {
  it('seek closes distance, flee opens it, wander keeps walking speed and turns the yaw', () => {
    const e = createEntities(4);
    const rabbit = SPECIES[SPECIES_ID.RABBIT];
    const t = walkableTile(); const x0 = tileX(t, terrain.size) + 0.5; const z0 = tileZ(t, terrain.size) + 0.5;
    const i = spawnCreature(e, { speciesId: 0, x: x0, z: z0, tick: 0 });
    const target = [x0 + 6, z0 + 3];
    const d0 = Math.hypot(target[0] - e.x[i], target[1] - e.z[i]);
    seekTo(e, i, target[0], target[1], rabbit.walkSpeed);
    expect(Math.hypot(e.vx[i], e.vz[i])).toBeCloseTo(rabbit.walkSpeed, 5);
    moveCreature(e, i, terrain, tileState, 0.5);
    expect(Math.hypot(target[0] - e.x[i], target[1] - e.z[i])).toBeLessThan(d0);
    fleeFrom(e, i, target[0], target[1], rabbit.runSpeed);
    moveCreature(e, i, terrain, tileState, 0.5);
    expect(Math.hypot(target[0] - e.x[i], target[1] - e.z[i])).toBeGreaterThan(d0 - rabbit.walkSpeed * 0.5);
    const rng = createRng(2);
    const yaw0 = e.yaw[i];
    let turned = false;
    for (let k = 0; k < 40; k++) { wander(e, i, rng, rabbit.walkSpeed); moveCreature(e, i, terrain, tileState, TICK_SECONDS); if (Math.abs(e.yaw[i] - yaw0) > 0.05) turned = true; }
    expect(turned).toBe(true);
    expect(Math.hypot(e.vx[i], e.vz[i])).toBeLessThanOrEqual(rabbit.walkSpeed + 1e-6);
  });

  it('never steps into water, mountains or off the map', () => {
    const e = createEntities(2);
    const rng = createRng(8);
    const t = walkableTile();
    const i = spawnCreature(e, { speciesId: SPECIES_ID.DEER, x: tileX(t, terrain.size) + 0.5, z: tileZ(t, terrain.size) + 0.5, tick: 0 });
    for (let k = 0; k < 4000; k++) {
      // Aim at the ocean corner, with jitter, so the walk keeps hitting the coast.
      const tx = rng.range(-50, 20); const tz = rng.range(-50, 20);
      seekTo(e, i, tx, tz, 8);
      moveCreature(e, i, terrain, tileState, TICK_SECONDS);
      const tile = tileIndex(e.x[i], e.z[i], terrain.size);
      expect(isWalkable(terrain.type[tile]), `step ${k} at ${e.x[i].toFixed(2)},${e.z[i].toFixed(2)}`).toBe(true);
      expect(e.x[i]).toBeGreaterThanOrEqual(0); expect(e.z[i]).toBeGreaterThanOrEqual(0);
      expect(e.x[i]).toBeLessThan(terrain.size); expect(e.z[i]).toBeLessThan(terrain.size);
    }
  });
});

describe('utility goals', () => {
  const ctxBase = () => ({
    tick: 1000, threatDist: Infinity, foodDist: Infinity, waterDist: Infinity, preyDist: Infinity, carcassDist: Infinity,
    mateDist: Infinity, parentDist: Infinity, homeDist: Infinity, night: false, hasHome: false,
    needsHut: false, logsCarried: 0, treeDist: Infinity, fear: 0,
  });
  const make = (speciesId, over = {}, traits = [0.5, 0.5, 0.5, 0.5, 0.5]) => {
    const e = createEntities(1);
    const i = spawnCreature(e, { speciesId, x: 5, z: 5, tick: 0, age: SPECIES[speciesId].matureYears + 1, traits: new Float32Array(traits) });
    Object.assign(e, {}); for (const [k, v] of Object.entries(over)) e[k][i] = v;
    return { e, i };
  };

  it('flees a nearby threat over eating, unless very bold', () => {
    const { e, i } = make(SPECIES_ID.RABBIT, { hunger: 0.8 });
    const ctx = { ...ctxBase(), threatDist: 6, foodDist: 2 };
    expect(chooseGoal(e, i, ctx)).toBe(GOAL.FLEE);
    const bold = make(SPECIES_ID.RABBIT, { hunger: 0.8 }, [1, 0.5, 0.5, 0.5, 0.5]);
    const s = scoreGoals(bold.e, bold.i, { ...ctx, threatDist: 11 });
    expect(s[GOAL.FLEE]).toBeLessThan(scoreGoals(e, i, { ...ctx, threatDist: 11 })[GOAL.FLEE]);
  });

  it('eats when hungry, drinks when thirstier, hunts when a wolf sees prey, wanders when content', () => {
    const hungry = make(SPECIES_ID.DEER, { hunger: 0.8, thirst: 0.2 });
    expect(chooseGoal(hungry.e, hungry.i, { ...ctxBase(), foodDist: 4, waterDist: 4 })).toBe(GOAL.EAT);
    const thirsty = make(SPECIES_ID.DEER, { hunger: 0.5, thirst: 0.85 });
    expect(chooseGoal(thirsty.e, thirsty.i, { ...ctxBase(), foodDist: 4, waterDist: 20 })).toBe(GOAL.DRINK);
    const wolf = make(SPECIES_ID.WOLF, { hunger: 0.7 });
    expect(chooseGoal(wolf.e, wolf.i, { ...ctxBase(), preyDist: 15 })).toBe(GOAL.HUNT);
    expect(chooseGoal(wolf.e, wolf.i, { ...ctxBase(), preyDist: 15, carcassDist: 3 })).toBe(GOAL.EAT);
    const content = make(SPECIES_ID.DEER, { hunger: 0.1, thirst: 0.1 });
    expect([GOAL.WANDER, GOAL.REST]).toContain(chooseGoal(content.e, content.i, ctxBase()));
  });

  it('juveniles follow a parent, adults mate when fit, humans go home at night and chop when a hut is needed', () => {
    const e = createEntities(2);
    const kid = spawnCreature(e, { speciesId: SPECIES_ID.DEER, x: 0, z: 0, tick: 0, age: 0.2 });
    expect(chooseGoal(e, kid, { ...ctxBase(), parentDist: 12 })).toBe(GOAL.FOLLOW_PARENT);
    const adult = make(SPECIES_ID.DEER, { hunger: 0.2, thirst: 0.2 });
    expect(chooseGoal(adult.e, adult.i, { ...ctxBase(), mateDist: 6 })).toBe(GOAL.MATE);
    const human = make(SPECIES_ID.HUMAN, { hunger: 0.3, thirst: 0.3 }, [0.5, 0.5, 0.5, 0.5, 0.9]);
    expect(chooseGoal(human.e, human.i, { ...ctxBase(), night: true, hasHome: true, homeDist: 30 })).toBe(GOAL.RETURN_HOME);
    expect(chooseGoal(human.e, human.i, { ...ctxBase(), hasHome: true, needsHut: true, treeDist: 10 })).toBe(GOAL.CHOP);
    expect(chooseGoal(human.e, human.i, { ...ctxBase(), hasHome: true, needsHut: true, logsCarried: 3, homeDist: 8 })).toBe(GOAL.BUILD);
    const lazy = make(SPECIES_ID.HUMAN, { hunger: 0.3, thirst: 0.3 }, [0.5, 0.5, 0.5, 0.5, 0.05]);
    expect(scoreGoals(lazy.e, lazy.i, { ...ctxBase(), hasHome: true, needsHut: true, treeDist: 10 })[GOAL.CHOP]).toBeLessThan(scoreGoals(human.e, human.i, { ...ctxBase(), hasHome: true, needsHut: true, treeDist: 10 })[GOAL.CHOP]);
  });

  it('keeps the current goal unless another beats it by the hysteresis margin', () => {
    const { e, i } = make(SPECIES_ID.RABBIT, { hunger: 0.52, thirst: 0.63 });
    const ctx = { ...ctxBase(), foodDist: 5, waterDist: 5 };
    const scores = scoreGoals(e, i, ctx);
    expect(Math.abs(scores[GOAL.EAT] - scores[GOAL.DRINK])).toBeLessThan(0.05);
    e.goal[i] = GOAL.DRINK;
    expect(chooseGoal(e, i, ctx)).toBe(GOAL.DRINK);
    e.goal[i] = GOAL.EAT;
    expect(chooseGoal(e, i, ctx)).toBe(GOAL.EAT);
    expect(TRAITS.length).toBe(5); expect(TRAIT.DILIGENCE).toBe(4);
  });
});
