import { describe, expect, it } from 'vitest';
import { fbm, valueNoise } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/noise.js';
import { generateIsland } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/island.js';
import { TILE, isWalkable, isWater, tileIndex, tileX, tileZ } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/tiles.js';
import { bfsDistanceField, descendStep, downhillNeighbour, shoreTiles } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/pathing.js';
import { WORLD_SIZE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const islands = new Map();
const island = (seed) => { if (!islands.has(seed)) islands.set(seed, generateIsland(seed)); return islands.get(seed); };

describe('noise', () => {
  it('is deterministic, bounded and continuous', () => {
    expect(valueNoise(3.7, 8.2, 11)).toBe(valueNoise(3.7, 8.2, 11));
    expect(valueNoise(3.7, 8.2, 11)).not.toBe(valueNoise(3.7, 8.2, 12));
    let maxJump = 0;
    for (let i = 0; i < 500; i++) {
      const a = fbm(i * 0.05, 4.2, 3, 4);
      const b = fbm((i + 1) * 0.05, 4.2, 3, 4);
      expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThanOrEqual(1);
      maxJump = Math.max(maxJump, Math.abs(a - b));
    }
    expect(maxJump).toBeLessThan(0.15);
  });
});

describe('island generation', () => {
  it('surrounds every seed with ocean and keeps the walkable ratio in range', () => {
    for (const seed of SEEDS) {
      const t = island(seed);
      expect(t.size).toBe(WORLD_SIZE);
      for (let i = 0; i < t.size; i++) {
        expect(t.type[tileIndex(i, 0, t.size)]).toBe(TILE.OCEAN);
        expect(t.type[tileIndex(i, t.size - 1, t.size)]).toBe(TILE.OCEAN);
        expect(t.type[tileIndex(0, i, t.size)]).toBe(TILE.OCEAN);
        expect(t.type[tileIndex(t.size - 1, i, t.size)]).toBe(TILE.OCEAN);
      }
      let walkable = 0;
      for (let i = 0; i < t.type.length; i++) if (isWalkable(t.type[i])) walkable++;
      const ratio = walkable / t.type.length;
      expect(ratio, `seed ${seed} walkable ratio ${ratio.toFixed(3)}`).toBeGreaterThanOrEqual(0.45);
      expect(ratio, `seed ${seed} walkable ratio ${ratio.toFixed(3)}`).toBeLessThanOrEqual(0.75);
    }
  });

  it('has at least one lake, exactly one volcano, and some of every biome', () => {
    for (const seed of SEEDS) {
      const t = island(seed);
      const counts = new Map();
      for (let i = 0; i < t.type.length; i++) counts.set(t.type[i], (counts.get(t.type[i]) ?? 0) + 1);
      expect(counts.get(TILE.VOLCANO), `seed ${seed} volcano`).toBe(1);
      expect(counts.get(TILE.LAKE) ?? 0, `seed ${seed} lake tiles`).toBeGreaterThanOrEqual(20);
      for (const k of [TILE.BEACH, TILE.GRASS, TILE.FOREST, TILE.HILL, TILE.MOUNTAIN]) {
        expect(counts.get(k) ?? 0, `seed ${seed} biome ${k}`).toBeGreaterThan(30);
      }
      expect(t.volcanoTile).toBeGreaterThanOrEqual(0);
      expect(t.type[t.volcanoTile]).toBe(TILE.VOLCANO);
    }
  });

  it('is reproducible per seed and distinct across seeds', () => {
    const a = generateIsland(7); const b = generateIsland(7); const c = generateIsland(8);
    expect(a.hash).toBe(b.hash);
    expect(a.type).toEqual(b.type);
    expect(a.height).toEqual(b.height);
    expect(a.hash).not.toBe(c.hash);
  });

  it('keeps land above sea level, water below, and interpolates heights', () => {
    const t = island(3);
    for (let i = 0; i < t.type.length; i++) {
      const h = t.tileHeight(i);
      if (t.type[i] === TILE.OCEAN) expect(h).toBeLessThan(0);
      else if (t.type[i] === TILE.LAKE) expect(h).toBeLessThanOrEqual(0.05);
      else expect(h).toBeGreaterThanOrEqual(0);
    }
    // heightAt is bilinear over the corner grid, so corner samples match exactly.
    expect(t.heightAt(50, 50)).toBeCloseTo(t.height[50 * (t.size + 1) + 50], 6);
    const mid = t.heightAt(50.5, 50.5);
    const corners = [t.height[50 * (t.size + 1) + 50], t.height[50 * (t.size + 1) + 51], t.height[51 * (t.size + 1) + 50], t.height[51 * (t.size + 1) + 51]];
    expect(mid).toBeGreaterThanOrEqual(Math.min(...corners) - 1e-6);
    expect(mid).toBeLessThanOrEqual(Math.max(...corners) + 1e-6);
    expect(t.heightAt(-5, 400)).toBeLessThan(0); // outside the map is ocean
    expect(t.maxHeight).toBeGreaterThan(5);
  });

  it('places the volcano at the summit and the beach along the shore', () => {
    const t = island(5);
    expect(t.tileHeight(t.volcanoTile)).toBeCloseTo(t.maxHeight, 3);
    const beach = [];
    for (let i = 0; i < t.type.length; i++) if (t.type[i] === TILE.BEACH) beach.push(i);
    const touchingWater = beach.filter(i => {
      const x = tileX(i, t.size); const z = tileZ(i, t.size);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (isWater(t.type[tileIndex(x + dx, z + dz, t.size)])) return true;
      }
      return false;
    });
    expect(touchingWater.length / beach.length).toBeGreaterThan(0.3);
  });
});

describe('pathing', () => {
  it('BFS from the shore reaches every walkable tile and descends monotonically', () => {
    for (const seed of [1, 4, 7]) {
      const t = island(seed);
      const field = bfsDistanceField(t, shoreTiles(t), i => isWalkable(t.type[i]));
      let unreachable = 0;
      for (let i = 0; i < t.type.length; i++) if (isWalkable(t.type[i]) && field[i] < 0) unreachable++;
      expect(unreachable, `seed ${seed}`).toBe(0);
      const start = (() => { for (let i = 0; i < t.type.length; i++) if (field[i] > 8) return i; return -1; })();
      expect(start).toBeGreaterThanOrEqual(0);
      let cur = start; let guard = 0;
      while (field[cur] > 0 && guard++ < 1000) {
        const next = descendStep(t, field, cur);
        expect(field[next]).toBeLessThan(field[cur]);
        cur = next;
      }
      expect(field[cur]).toBe(0);
    }
  });

  it('downhillNeighbour follows the heightmap and stops in basins', () => {
    const t = island(2);
    let cur = t.volcanoTile; let steps = 0;
    while (steps++ < 400) {
      const next = downhillNeighbour(t, cur);
      if (next === cur) break;
      expect(t.tileHeight(next)).toBeLessThan(t.tileHeight(cur));
      cur = next;
    }
    expect(steps).toBeGreaterThan(3);
    expect(isWater(t.type[cur]) || downhillNeighbour(t, cur) === cur).toBe(true);
  });
});
