// trees.js — trees on a seeded fraction of forest tiles. A tree can be chopped
// (humans, logs for huts) or burnt (fire, lightning); either leaves a stump that
// regrows after FLORA.treeRegrowSeconds (twice that when burnt). The physics side
// spawns the falling trunk; this module only tracks the standing/stump state.
import { FLORA } from '../core/config.js';
import { TILE, TILE_STATE } from '../terrain/tiles.js';

export const TREE_STATE = Object.freeze({ STANDING: 0, STUMP: 1 });

export function createTrees(terrain, rng) {
  const { size, type } = terrain;
  const tiles = [];
  for (let i = 0; i < type.length; i++) if (type[i] === TILE.FOREST && rng.next() < FLORA.treeDensity) tiles.push(i);
  const count = tiles.length;
  const tile = Int32Array.from(tiles);
  const byTile = new Int32Array(size * size).fill(-1);
  for (let k = 0; k < count; k++) byTile[tile[k]] = k;
  const state = new Uint8Array(count);
  const regrow = new Float32Array(count);
  const trees = {
    count, tile, byTile, state, regrow,
    standingCount() { let n = 0; for (let k = 0; k < count; k++) if (state[k] === TREE_STATE.STANDING) n++; return n; },
  };
  return trees;
}

function fell(trees, k, tileState, regrowSeconds, newTileState) {
  if (trees.state[k] !== TREE_STATE.STANDING) return false;
  trees.state[k] = TREE_STATE.STUMP;
  trees.regrow[k] = regrowSeconds;
  tileState[trees.tile[k]] = newTileState;
  return true;
}

export const chopTree = (trees, k, tileState) => fell(trees, k, tileState, FLORA.treeRegrowSeconds, TILE_STATE.STUMP);
export const burnTree = (trees, k, tileState) => fell(trees, k, tileState, FLORA.treeRegrowSeconds * FLORA.treeBurnRegrowMultiplier, TILE_STATE.BURNT);

export function stepTrees(trees, tileState, dt) {
  const { count, state, regrow, tile } = trees;
  for (let k = 0; k < count; k++) {
    if (state[k] === TREE_STATE.STANDING) continue;
    regrow[k] -= dt;
    if (regrow[k] <= 0) {
      state[k] = TREE_STATE.STANDING;
      regrow[k] = 0;
      const s = tileState[tile[k]];
      if (s === TILE_STATE.STUMP || s === TILE_STATE.BURNT) tileState[tile[k]] = TILE_STATE.NORMAL;
    }
  }
}
