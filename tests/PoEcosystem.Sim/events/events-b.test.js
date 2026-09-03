import { describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import { createWorld, nullPhysics } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/world.js';
import { createPhysics } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/physics/world.js';
import { generateIsland } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/island.js';
import { TILE, TILE_STATE, isFlammable, tileIndex, tileX, tileZ } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/tiles.js';
import { SPECIES_ID } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/species.js';
import { DEATH_CAUSE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/lifecycle.js';
import { EVENTS, TICK_SECONDS } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

const secs = (s) => Math.round(s / TICK_SECONDS);
const stepN = (w, n) => { for (let k = 0; k < n; k++) w.step(); };
const countState = (w, state) => { let n = 0; for (let i = 0; i < w.tileState.length; i++) if (w.tileState[i] === state) n++; return n; };

// A grass tile whose 5×5 neighbourhood is all grass with full biomass — fire must spread here.
function openGrass(w) {
  const { size, type } = w.terrain;
  for (let i = 0; i < type.length; i++) {
    if (type[i] !== TILE.GRASS) continue;
    const x = tileX(i, size); const z = tileZ(i, size);
    let ok = x > 3 && z > 3 && x < size - 4 && z < size - 4;
    for (let dz = -2; dz <= 2 && ok; dz++) for (let dx = -2; dx <= 2; dx++) if (type[tileIndex(x + dx, z + dz, size)] !== TILE.GRASS) { ok = false; break; }
    if (ok) { for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) w.grass.biomass[tileIndex(x + dx, z + dz, size)] = 1; return i; }
  }
  return -1;
}

describe('fire', () => {
  it('spreads across flammable tiles, never onto sand/water/rock, and burnt tiles recover', () => {
    const w = createWorld({ seed: 7 });
    w.debug('massKill');
    const start = openGrass(w);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(w.ignite(start)).toBe(true);
    stepN(w, secs(12));
    const burning = countState(w, TILE_STATE.FIRE); const burnt = countState(w, TILE_STATE.BURNT);
    expect(burning + burnt).toBeGreaterThan(1);
    for (let i = 0; i < w.tileState.length; i++) {
      if (w.tileState[i] === TILE_STATE.FIRE || w.tileState[i] === TILE_STATE.BURNT) expect(isFlammable(w.terrain.type[i])).toBe(true);
    }
    expect(w.grass.biomass[start]).toBe(0);
    // A grassland fire must burn itself out (offspring < 1 per burning tile), then recover.
    stepN(w, secs(240));
    expect(countState(w, TILE_STATE.FIRE)).toBe(0);
    stepN(w, secs(EVENTS.burntSeconds + 2));
    expect(w.tileState[start]).toBe(TILE_STATE.NORMAL);
  });

  it('does not spread from a tile with nothing flammable around it, and kills what stands in it', () => {
    const w = createWorld({ seed: 7 });
    w.debug('massKill');
    const { size, type } = w.terrain;
    let lone = -1;
    for (let i = 0; i < type.length && lone < 0; i++) {
      if (type[i] !== TILE.GRASS) continue;
      const x = tileX(i, size); const z = tileZ(i, size);
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => !isFlammable(type[tileIndex(x + dx, z + dz, size)]))) lone = i;
    }
    if (lone >= 0) {
      w.ignite(lone);
      stepN(w, secs(EVENTS.fireSeconds + 1));
      expect(countState(w, TILE_STATE.FIRE)).toBe(0);
      expect(countState(w, TILE_STATE.BURNT)).toBe(1);
    }
    const t = openGrass(w);
    const cx = tileX(t, size) + 0.5; const cz = tileZ(t, size) + 0.5;
    const victim = w.spawn(SPECIES_ID.DEER, cx, cz);
    w.ignite(t);
    for (let k = 0; k < secs(5) && w.entities.alive[victim]; k++) { w.entities.vx[victim] = 0; w.entities.vz[victim] = 0; w.entities.x[victim] = cx; w.entities.z[victim] = cz; w.step(); }
    expect(w.entities.alive[victim]).toBe(0);
    expect(w.log.all().some(ev => ev.kind === 'death' && ev.cause === DEATH_CAUSE.FIRE)).toBe(true);
  });

  it('is deterministic', () => {
    const a = createWorld({ seed: 8 }); const b = createWorld({ seed: 8 });
    const t = openGrass(a); openGrass(b);
    a.ignite(t); b.ignite(t);
    stepN(a, secs(20)); stepN(b, secs(20));
    expect(Array.from(a.tileState)).toEqual(Array.from(b.tileState));
  });
});

describe('volcano', () => {
  it('erupts: explosion, projectiles, creeping lava that cools, fear, and a log entry', () => {
    const w = createWorld({ seed: 6 });
    w.debug('massKill');
    const v = w.terrain.volcanoTile;
    expect(w.debug('erupt')).toBeTruthy();
    expect(w.stats().naturalEvents.eruption).toBe(1);
    expect(w.log.all().some(ev => ev.kind === 'eruption')).toBe(true);
    expect(w.corridors.length).toBeGreaterThanOrEqual(EVENTS.volcano.projectiles[0]);
    expect(w.corridors.every(r => r.cause === DEATH_CAUSE.ERUPTION)).toBe(true);
    const vx = tileX(v, w.terrain.size) + 0.5; const vz = tileZ(v, w.terrain.size) + 0.5;
    expect(w.fear[tileIndex(vx + 30, vz, w.terrain.size)]).toBeGreaterThan(0);
    stepN(w, secs(5));
    const lavaEarly = countState(w, TILE_STATE.LAVA);
    expect(lavaEarly).toBeGreaterThan(2);
    stepN(w, secs(EVENTS.volcano.lavaSeconds));
    expect(countState(w, TILE_STATE.LAVA)).toBe(0);
    expect(countState(w, TILE_STATE.COOLED)).toBeGreaterThanOrEqual(lavaEarly);
    // Lava only ever flows downhill from the crater; every cooled tile is lower than the summit.
    for (let i = 0; i < w.tileState.length; i++) if (w.tileState[i] === TILE_STATE.COOLED) expect(w.terrain.tileHeight(i)).toBeLessThanOrEqual(w.terrain.tileHeight(v) + 1e-6);
  });

  it('kills creatures the lava reaches with the eruption cause', () => {
    const w = createWorld({ seed: 6 });
    w.debug('massKill');
    w.debug('erupt');
    stepN(w, secs(3));
    let lavaTile = -1;
    for (let i = 0; i < w.tileState.length; i++) if (w.tileState[i] === TILE_STATE.LAVA) { lavaTile = i; break; }
    expect(lavaTile).toBeGreaterThanOrEqual(0);
    const cx = tileX(lavaTile, w.terrain.size) + 0.5; const cz = tileZ(lavaTile, w.terrain.size) + 0.5;
    const victim = w.spawn(SPECIES_ID.WOLF, cx, cz);
    for (let k = 0; k < secs(6) && w.entities.alive[victim]; k++) { w.entities.vx[victim] = 0; w.entities.vz[victim] = 0; w.entities.x[victim] = cx; w.entities.z[victim] = cz; w.step(); }
    expect(w.entities.alive[victim]).toBe(0);
    expect(w.log.all().some(ev => ev.kind === 'death' && ev.cause === DEATH_CAUSE.ERUPTION)).toBe(true);
  });
});

describe('CP-D: every event on, cannon vs null physics', () => {
  it('gives identical populations, positions and log at tick 3000', { timeout: 90_000 }, () => {
    const seed = 13;
    const a = createWorld({ seed, physics: createPhysics(CANNON, generateIsland(seed)) });
    const b = createWorld({ seed, physics: nullPhysics() });
    for (const w of [a, b]) { w.debug('erupt'); w.debug('lightning'); w.debug('rockslide'); }
    for (let k = 0; k < 3000; k++) { a.step(); b.step(); }
    expect(a.stats().counts).toEqual(b.stats().counts);
    expect(a.stats().naturalEvents).toEqual(b.stats().naturalEvents);
    const pa = []; const pb = [];
    a.entities.forEachAlive(i => pa.push(i, a.entities.x[i], a.entities.z[i]));
    b.entities.forEachAlive(i => pb.push(i, b.entities.x[i], b.entities.z[i]));
    expect(pa).toEqual(pb);
    expect(a.log.all().map(ev => ev.text)).toEqual(b.log.all().map(ev => ev.text));
    expect(Array.from(a.tileState)).toEqual(Array.from(b.tileState));
    a.physics.dispose();
  });
});
