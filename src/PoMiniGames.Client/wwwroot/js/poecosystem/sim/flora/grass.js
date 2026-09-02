// grass.js — per-tile grass biomass in [0,1]. Herbivores graze it; it regrows
// logistically at a biome-specific rate, and not at all while the tile is burning,
// burnt, under lava or built on.
import { FLORA } from '../core/config.js';
import { TILE, TILE_STATE } from '../terrain/tiles.js';

const initFor = (type) => type === TILE.GRASS ? FLORA.grassInit.grass : type === TILE.FOREST ? FLORA.grassInit.forest : type === TILE.HILL ? FLORA.grassInit.hill : 0;
const rateFor = (type) => type === TILE.GRASS ? FLORA.grassRate.grass : type === TILE.FOREST ? FLORA.grassRate.forest : type === TILE.HILL ? FLORA.grassRate.hill : 0;

export function createGrass(terrain) {
  const n = terrain.size * terrain.size;
  const biomass = new Float32Array(n);
  const rate = new Float32Array(n);
  for (let i = 0; i < n; i++) { biomass[i] = initFor(terrain.type[i]); rate[i] = rateFor(terrain.type[i]); }
  // Regrowth is sliced: each call advances one of GRASS_SLICES interleaved tile sets by
  // dt·GRASS_SLICES, so every tile updates once per second and a tick touches 2 000 tiles.
  return { biomass, rate, cursor: 0 };
}

export const GRASS_SLICES = 20;

const blocksGrowth = (s) => s === TILE_STATE.FIRE || s === TILE_STATE.BURNT || s === TILE_STATE.LAVA || s === TILE_STATE.HUT;

export function stepGrass(grass, terrain, tileState, dt) {
  const { biomass, rate } = grass;
  const slice = grass.cursor;
  grass.cursor = (slice + 1) % GRASS_SLICES;
  const sdt = dt * GRASS_SLICES;
  for (let i = slice; i < biomass.length; i += GRASS_SLICES) {
    const r = rate[i];
    if (r === 0 || blocksGrowth(tileState[i])) continue;
    const b = biomass[i];
    if (b >= 1) continue;
    const nb = b + r * (b + FLORA.grassSeed) * (1 - b) * sdt;
    biomass[i] = nb > 1 ? 1 : nb;
  }
}

/** Remove up to `amount` biomass from a tile; returns what was actually eaten. */
export function grazeAt(grass, tile, amount) {
  const have = grass.biomass[tile];
  const eaten = have < amount ? have : amount;
  grass.biomass[tile] = have - eaten;
  return eaten;
}
