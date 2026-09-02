import { describe, expect, it } from 'vitest';
import { STATE, herdCohesion, isAlerted, isOrphan, packLeader, raiseAlarm, scatterDirection, shareKill } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/behavior/social.js';
import { addHut, bedsTotal, buildHut, chooseHutSite, createSettlement, giveLogs, isNight, nearestHut, needsHut } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/behavior/humans.js';
import { createSpatialHash } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/spatial.js';
import { createEntities, NONE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/entities.js';
import { createEventLog } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/events.js';
import { createRng } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/prng.js';
import { spawnCreature } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/lifecycle.js';
import { SPECIES, SPECIES_ID } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/species.js';
import { generateIsland } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/island.js';
import { TILE, TILE_STATE, tileIndex, tileX, tileZ } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/tiles.js';
import { BEHAVIOR, FLORA, WORLD_SIZE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

const adultAge = (id) => SPECIES[id].matureYears + 1;
const put = (e, speciesId, x, z, over = {}) => spawnCreature(e, { speciesId, x, z, tick: 0, age: adultAge(speciesId), ...over });

describe('herd and pack', () => {
  it('raiseAlarm alerts same-species neighbours in radius and the alert expires', () => {
    const e = createEntities(16); const hash = createSpatialHash(WORLD_SIZE);
    const spotter = put(e, SPECIES_ID.DEER, 50, 50);
    const near = put(e, SPECIES_ID.DEER, 56, 50);
    const far = put(e, SPECIES_ID.DEER, 90, 50);
    const rabbit = put(e, SPECIES_ID.RABBIT, 51, 51);
    hash.rebuild(e);
    raiseAlarm(e, hash, spotter, 15, 100);
    expect(isAlerted(e, near, 100)).toBe(true);
    expect(isAlerted(e, spotter, 100)).toBe(true);
    expect(isAlerted(e, far, 100)).toBe(false);
    expect(isAlerted(e, rabbit, 100)).toBe(false);
    expect(e.state[near]).toBe(STATE.ALERT);
    expect(isAlerted(e, near, 100 + BEHAVIOR.alertTicks + 1)).toBe(false);
  });

  it('herdCohesion averages same-species neighbours and scatterDirection points away with spread', () => {
    const e = createEntities(8); const hash = createSpatialHash(WORLD_SIZE);
    const me = put(e, SPECIES_ID.DEER, 20, 20);
    put(e, SPECIES_ID.DEER, 24, 20); put(e, SPECIES_ID.DEER, 20, 24); put(e, SPECIES_ID.WOLF, 22, 22);
    hash.rebuild(e);
    const c = herdCohesion(e, hash, me, 10);
    expect(c.n).toBe(2);
    expect(c.cx).toBeCloseTo(22, 5); expect(c.cz).toBeCloseTo(22, 5);
    const alone = herdCohesion(e, hash, me, 1);
    expect(alone.n).toBe(0);
    const rng = createRng(3);
    const dir = scatterDirection(e, me, 10, 20, rng); // threat due west
    expect(Math.hypot(dir.x, dir.z)).toBeCloseTo(1, 5);
    expect(dir.x).toBeGreaterThan(0.3);                 // mostly east
    const dirs = new Set(Array.from({ length: 20 }, () => scatterDirection(e, me, 10, 20, rng).z.toFixed(2)));
    expect(dirs.size).toBeGreaterThan(5);                // but spread out
  });

  it('packLeader is the lowest-index adult wolf nearby and shareKill feeds the pack', () => {
    const e = createEntities(8); const hash = createSpatialHash(WORLD_SIZE);
    const a = put(e, SPECIES_ID.WOLF, 40, 40); const b = put(e, SPECIES_ID.WOLF, 43, 40);
    const c = put(e, SPECIES_ID.WOLF, 40, 44); const far = put(e, SPECIES_ID.WOLF, 120, 120);
    const pup = put(e, SPECIES_ID.WOLF, 41, 41, { age: 0.5 });
    hash.rebuild(e);
    expect(packLeader(e, hash, c, 12)).toBe(a);
    expect(packLeader(e, hash, far, 12)).toBe(far);
    for (const i of [a, b, c, far, pup]) e.hunger[i] = 0.9;
    const fed = shareKill(e, hash, b, 12, 1.0);
    expect(fed).toBe(4);
    expect(e.hunger[b]).toBeCloseTo(0.4, 5);              // killer takes half
    expect(e.hunger[a]).toBeCloseTo(0.9 - 0.5 / 3, 5);    // the rest is split
    expect(e.hunger[pup]).toBeCloseTo(0.9 - 0.5 / 3, 5);
    expect(e.hunger[far]).toBeCloseTo(0.9, 5);
  });

  it('isOrphan resolves parent handles and orphans carry the hunger multiplier', () => {
    const e = createEntities(4);
    const mum = put(e, SPECIES_ID.RABBIT, 5, 5);
    const kid = spawnCreature(e, { speciesId: SPECIES_ID.RABBIT, x: 5, z: 5, tick: 0, age: 0.2, mother: e.handle(mum), father: NONE });
    expect(isOrphan(e, kid)).toBe(false);
    e.free(mum);
    expect(isOrphan(e, kid)).toBe(true);
    expect(isOrphan(e, put(e, SPECIES_ID.RABBIT, 5, 5))).toBe(false); // adults are never orphans
    expect(BEHAVIOR.orphanHungerMultiplier).toBe(1.5);
  });
});

describe('humans and huts', () => {
  const terrain = generateIsland(3);
  const grassNearWater = () => {
    for (let i = 0; i < terrain.type.length; i++) {
      if (terrain.type[i] !== TILE.GRASS) continue;
      const x = tileX(i, terrain.size); const z = tileZ(i, terrain.size);
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
        const t = terrain.type[tileIndex(x + dx, z + dz, terrain.size)];
        if (t === TILE.LAKE || t === TILE.OCEAN) return i;
      }
    }
    return -1;
  };

  it('tracks huts, beds and the need for more housing', () => {
    const s = createSettlement(8);
    const tileState = new Uint8Array(terrain.size * terrain.size);
    const site = grassNearWater();
    addHut(s, terrain, tileState, site);
    expect(s.huts.length).toBe(1);
    expect(tileState[site]).toBe(TILE_STATE.HUT);
    expect(bedsTotal(s)).toBe(BEHAVIOR.bedsPerHut);
    expect(needsHut(s, BEHAVIOR.bedsPerHut)).toBe(false);
    expect(needsHut(s, BEHAVIOR.bedsPerHut + 1)).toBe(true);
    const h = nearestHut(s, tileX(site, terrain.size) + 10, tileZ(site, terrain.size));
    expect(h.tile).toBe(site);
    expect(nearestHut(createSettlement(1), 0, 0)).toBe(null);
  });

  it('chooses new hut sites on free grassland near the village, never on water or another hut', () => {
    const s = createSettlement(8);
    const tileState = new Uint8Array(terrain.size * terrain.size);
    const rng = createRng(5);
    const first = chooseHutSite(s, terrain, tileState, rng);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(terrain.type[first]).toBe(TILE.GRASS);
    addHut(s, terrain, tileState, first);
    const sites = new Set();
    for (let k = 0; k < 6; k++) {
      const site = chooseHutSite(s, terrain, tileState, rng);
      expect(site).toBeGreaterThanOrEqual(0);
      expect(terrain.type[site]).toBe(TILE.GRASS);
      expect(tileState[site]).toBe(TILE_STATE.NORMAL);
      const dx = tileX(site, terrain.size) - tileX(first, terrain.size); const dz = tileZ(site, terrain.size) - tileZ(first, terrain.size);
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(BEHAVIOR.hutSiteRadius + 0.01);
      expect(sites.has(site)).toBe(false);
      sites.add(site);
      addHut(s, terrain, tileState, site);
    }
  });

  it('logs are carried per human and three of them build a hut that is logged', () => {
    const e = createEntities(4);
    const s = createSettlement(e.cap);
    const tileState = new Uint8Array(terrain.size * terrain.size);
    const log = createEventLog(10);
    addHut(s, terrain, tileState, grassNearWater());
    const i = put(e, SPECIES_ID.HUMAN, tileX(s.huts[0].tile, terrain.size), tileZ(s.huts[0].tile, terrain.size));
    expect(s.carried[i]).toBe(0);
    giveLogs(s, i, FLORA.logsPerTree);
    expect(s.carried[i]).toBe(3);
    expect(buildHut(e, i, s, terrain, tileState, createRng(1), log, 500)).toBe(true);
    expect(s.huts.length).toBe(2);
    expect(s.carried[i]).toBe(0);
    expect(log.all()[0].kind).toBe('hut');
    expect(log.all()[0].tick).toBe(500);
    expect(buildHut(e, i, s, terrain, tileState, createRng(1), log, 501)).toBe(false);
  });

  it('isNight follows the light cycle', () => {
    expect(isNight(0.0)).toBe(true);
    expect(isNight(0.3)).toBe(false);
    expect(isNight(0.5)).toBe(false);
    expect(isNight(0.8)).toBe(true);
    expect(isNight(0.95)).toBe(true);
  });
});
