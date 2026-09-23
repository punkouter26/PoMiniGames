// bushes.js — berry bushes on forest edges. Placement is a seeded pass over tiles in
// index order (deterministic); ripeness climbs 0 → 1 over FLORA.bushRipenSeconds and a
// ripe bush is stripped in one meal.
import { FLORA } from '../core/config.js';
import { NEIGHBOURS4, TILE, tileIndex, tileX, tileZ } from '../terrain/tiles.js';

export function createBushes(terrain, rng) {
  const { size, type } = terrain;
  const tile = new Int32Array(FLORA.maxBushes);
  const byTile = new Int32Array(size * size).fill(-1);
  let count = 0;
  for (let i = 0; i < type.length && count < FLORA.maxBushes; i++) {
    if (type[i] !== TILE.FOREST) continue;
    const x = tileX(i, size); const z = tileZ(i, size);
    let edge = false;
    for (const [dx, dz] of NEIGHBOURS4) if (type[tileIndex(x + dx, z + dz, size)] === TILE.GRASS) { edge = true; break; }
    if (!edge || rng.next() >= FLORA.bushChance) continue;
    tile[count] = i; byTile[i] = count; count++;
  }
  const ripeness = new Float32Array(FLORA.maxBushes);
  for (let k = 0; k < count; k++) ripeness[k] = rng.next();
  // fast[k] = 1 marks a cultivated plot (behavior/tech.js farming): same bush, quicker crop.
  const fast = new Uint8Array(FLORA.maxBushes);
  return { count, tile, byTile, ripeness, fast };
}

/** Plant a bush on a tile at runtime (farming). Returns its index, or -1 when full/occupied. */
export function plantBush(bushes, tileIdx, { fast = false } = {}) {
  if (bushes.count >= FLORA.maxBushes || bushes.byTile[tileIdx] >= 0) return -1;
  const k = bushes.count++;
  bushes.tile[k] = tileIdx; bushes.byTile[tileIdx] = k;
  bushes.ripeness[k] = 0; bushes.fast[k] = fast ? 1 : 0;
  return k;
}

export function stepBushes(bushes, dt, fastMultiplier = 1) {
  const { ripeness, count, fast } = bushes;
  const step = dt / FLORA.bushRipenSeconds;
  for (let k = 0; k < count; k++) {
    if (ripeness[k] >= 1) continue;
    const r = ripeness[k] + (fast && fast[k] ? step * fastMultiplier : step);
    ripeness[k] = r > 1 ? 1 : r;
  }
}

export const isRipe = (bushes, k) => bushes.ripeness[k] >= 0.5;

/** Eat a bush: returns the food value (0 when unripe) and resets ripeness. */
export function stripBush(bushes, k) {
  if (!isRipe(bushes, k)) return 0;
  bushes.ripeness[k] = 0;
  return FLORA.bushFoodValue;
}

/** Dries up all bushes on the island (weather catastrophe). */
export function dryUpBushes(bushes) {
  bushes.ripeness.fill(0);
}
