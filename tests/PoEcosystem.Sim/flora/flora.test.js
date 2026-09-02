import { describe, expect, it } from 'vitest';
import { createGrass, grazeAt, stepGrass } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/flora/grass.js';
import { createBushes, stepBushes, stripBush } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/flora/bushes.js';
import { TREE_STATE, burnTree, chopTree, createTrees, stepTrees } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/flora/trees.js';
import { generateIsland } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/island.js';
import { TILE, TILE_STATE, tileIndex, tileX, tileZ } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/tiles.js';
import { createRng } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/prng.js';
import { FLORA, TICK_SECONDS } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

const terrain = generateIsland(4);
const tileState = new Uint8Array(terrain.size * terrain.size);
const firstTileOf = (type) => { for (let i = 0; i < terrain.type.length; i++) if (terrain.type[i] === type) return i; return -1; };
const runSeconds = (fn, seconds) => { for (let t = 0; t < seconds / TICK_SECONDS; t++) fn(TICK_SECONDS); };

describe('grass', () => {
  it('starts by biome, is absent on sand/rock/water and regrows logistically', () => {
    const g = createGrass(terrain);
    expect(g.biomass[firstTileOf(TILE.GRASS)]).toBeGreaterThan(0.5);
    expect(g.biomass[firstTileOf(TILE.BEACH)]).toBe(0);
    expect(g.biomass[firstTileOf(TILE.OCEAN)]).toBe(0);
    expect(g.biomass[firstTileOf(TILE.MOUNTAIN)]).toBe(0);
    const grassTile = firstTileOf(TILE.GRASS); const hillTile = firstTileOf(TILE.HILL); const beach = firstTileOf(TILE.BEACH);
    g.biomass[grassTile] = 0.1; g.biomass[hillTile] = 0.1; g.biomass[beach] = 0;
    runSeconds(dt => stepGrass(g, terrain, tileState, dt), 120);
    expect(g.biomass[grassTile]).toBeGreaterThan(0.7);
    expect(g.biomass[hillTile]).toBeGreaterThan(0.1);
    expect(g.biomass[hillTile]).toBeLessThan(g.biomass[grassTile]);
    expect(g.biomass[beach]).toBe(0);
    runSeconds(dt => stepGrass(g, terrain, tileState, dt), 200);
    for (let i = 0; i < g.biomass.length; i++) expect(g.biomass[i]).toBeLessThanOrEqual(1);
  });

  it('grazing takes what is there and burnt tiles stay bare until they recover', () => {
    const g = createGrass(terrain);
    const t = firstTileOf(TILE.GRASS);
    g.biomass[t] = 0.3;
    expect(grazeAt(g, t, 0.2)).toBeCloseTo(0.2, 6);
    expect(grazeAt(g, t, 0.5)).toBeCloseTo(0.1, 6);
    expect(g.biomass[t]).toBe(0);
    const burnt = new Uint8Array(tileState.length); burnt[t] = TILE_STATE.BURNT;
    runSeconds(dt => stepGrass(g, terrain, burnt, dt), 60);
    expect(g.biomass[t]).toBe(0);
    burnt[t] = TILE_STATE.NORMAL;
    runSeconds(dt => stepGrass(g, terrain, burnt, dt), 60);
    expect(g.biomass[t]).toBeGreaterThan(0.05);
  });
});

describe('bushes', () => {
  it('sit on forest edges within the density cap, ripen in 40 s and strip on eating', () => {
    const b = createBushes(terrain, createRng(4));
    expect(b.count).toBeGreaterThan(20);
    expect(b.count).toBeLessThanOrEqual(FLORA.maxBushes);
    for (let k = 0; k < b.count; k++) {
      const i = b.tile[k];
      expect(terrain.type[i]).toBe(TILE.FOREST);
      const x = tileX(i, terrain.size); const z = tileZ(i, terrain.size);
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => terrain.type[tileIndex(x + dx, z + dz, terrain.size)] === TILE.GRASS);
      expect(edge).toBe(true);
      expect(b.byTile[i]).toBe(k);
    }
    b.ripeness[0] = 0;
    runSeconds(dt => stepBushes(b, dt), 39);
    expect(b.ripeness[0]).toBeLessThan(1);
    runSeconds(dt => stepBushes(b, dt), 2);
    expect(b.ripeness[0]).toBe(1);
    expect(stripBush(b, 0)).toBeGreaterThan(0);
    expect(b.ripeness[0]).toBe(0);
    expect(stripBush(b, 0)).toBe(0);
    const again = createBushes(terrain, createRng(4));
    expect(Array.from(again.tile.subarray(0, again.count))).toEqual(Array.from(b.tile.subarray(0, b.count)));
  });
});

describe('trees', () => {
  it('stand on a fraction of forest tiles, fall to chopping, burn, and regrow slowly', () => {
    const tr = createTrees(terrain, createRng(4));
    let forest = 0;
    for (let i = 0; i < terrain.type.length; i++) if (terrain.type[i] === TILE.FOREST) forest++;
    expect(tr.count).toBeGreaterThan(forest * (FLORA.treeDensity - 0.08));
    expect(tr.count).toBeLessThan(forest * (FLORA.treeDensity + 0.08));
    for (let k = 0; k < tr.count; k++) expect(terrain.type[tr.tile[k]]).toBe(TILE.FOREST);
    const k = 0; const states = new Uint8Array(tileState.length);
    expect(tr.state[k]).toBe(TREE_STATE.STANDING);
    expect(chopTree(tr, k, states)).toBe(true);
    expect(tr.state[k]).toBe(TREE_STATE.STUMP);
    expect(states[tr.tile[k]]).toBe(TILE_STATE.STUMP);
    expect(chopTree(tr, k, states)).toBe(false);
    runSeconds(dt => stepTrees(tr, states, dt), FLORA.treeRegrowSeconds - 5);
    expect(tr.state[k]).not.toBe(TREE_STATE.STANDING);
    runSeconds(dt => stepTrees(tr, states, dt), 10);
    expect(tr.state[k]).toBe(TREE_STATE.STANDING);
    expect(states[tr.tile[k]]).toBe(TILE_STATE.NORMAL);
    burnTree(tr, k, states);
    expect(tr.state[k]).toBe(TREE_STATE.STUMP);
    expect(tr.regrow[k]).toBeGreaterThan(FLORA.treeRegrowSeconds);
    expect(tr.byTile[tr.tile[k]]).toBe(k);
    expect(tr.standingCount()).toBe(tr.count - 1);
  });
});
