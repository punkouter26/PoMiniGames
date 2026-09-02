// memory.js — where a creature last found food or water, forgotten after a while.
import { MEMORY, TICK_SECONDS } from '../core/config.js';
import { NONE } from '../core/entities.js';

export const MEMORY_KIND = Object.freeze({ FOOD: 0, WATER: 1 });

const FOOD_TICKS = Math.round(MEMORY.foodSeconds / TICK_SECONDS);
const WATER_TICKS = Math.round(MEMORY.waterSeconds / TICK_SECONDS);

export function remember(e, i, kind, tile, tick) {
  if (kind === MEMORY_KIND.FOOD) { e.memFoodTile[i] = tile; e.memFoodTick[i] = tick; }
  else { e.memWaterTile[i] = tile; e.memWaterTick[i] = tick; }
}

/** The remembered tile, or NONE when nothing is remembered or it has decayed. */
export function recall(e, i, kind, tick) {
  const tile = kind === MEMORY_KIND.FOOD ? e.memFoodTile[i] : e.memWaterTile[i];
  if (tile === NONE) return NONE;
  const since = tick - (kind === MEMORY_KIND.FOOD ? e.memFoodTick[i] : e.memWaterTick[i]);
  return since > (kind === MEMORY_KIND.FOOD ? FOOD_TICKS : WATER_TICKS) ? NONE : tile;
}

export function forget(e, i, kind) {
  if (kind === MEMORY_KIND.FOOD) e.memFoodTile[i] = NONE; else e.memWaterTile[i] = NONE;
}
