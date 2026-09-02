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
  return { count, tile, byTile, ripeness };
}

export function stepBushes(bushes, dt) {
  const { ripeness, count } = bushes;
  const step = dt / FLORA.bushRipenSeconds;
  for (let k = 0; k < count; k++) {
    if (ripeness[k] >= 1) continue;
    const r = ripeness[k] + step;
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
