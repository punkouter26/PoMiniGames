// tiles.js — tile vocabulary shared by terrain, flora, fire, rendering and the minimap.

export const TILE = Object.freeze({
  OCEAN: 0, BEACH: 1, GRASS: 2, FOREST: 3, HILL: 4, MOUNTAIN: 5, LAKE: 6, VOLCANO: 7,
});

// Transient per-tile state layered over the type (fire, lava, stumps, huts, boulders).
export const TILE_STATE = Object.freeze({
  NORMAL: 0, FIRE: 1, BURNT: 2, LAVA: 3, COOLED: 4, STUMP: 5, HUT: 6, BOULDER: 7,
});

export const isWater = (type) => type === TILE.OCEAN || type === TILE.LAKE;
export const isWalkable = (type) => type === TILE.BEACH || type === TILE.GRASS || type === TILE.FOREST || type === TILE.HILL;
export const isFlammable = (type) => type === TILE.GRASS || type === TILE.FOREST;
export const growsGrass = (type) => type === TILE.GRASS || type === TILE.FOREST || type === TILE.HILL;

/** Tile index for (x, z), clamped to the map so neighbour walks never leave it. */
export function tileIndex(x, z, size) {
  const cx = x < 0 ? 0 : x >= size ? size - 1 : x | 0;
  const cz = z < 0 ? 0 : z >= size ? size - 1 : z | 0;
  return cz * size + cx;
}
export const tileX = (i, size) => i % size;
export const tileZ = (i, size) => (i / size) | 0;

/** 4-neighbourhood in a fixed order (E, W, S, N) — order matters for determinism. */
export const NEIGHBOURS4 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);
/** 8-neighbourhood, also fixed order. */
export const NEIGHBOURS8 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]);
