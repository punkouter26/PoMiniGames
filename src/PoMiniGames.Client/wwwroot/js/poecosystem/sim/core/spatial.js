// spatial.js — uniform grid over creature positions, rebuilt every tick by a counting
// sort (two passes, zero allocation after warm-up, deterministic order: cells ascend,
// entities ascend within a cell).
import { BEHAVIOR } from './config.js';

export function createSpatialHash(worldSize, cellSize = BEHAVIOR.spatialCell) {
  const cells = Math.ceil(worldSize / cellSize);
  const cellStart = new Int32Array(cells * cells + 1);
  let entries = new Int32Array(0);
  let cellOf = new Int32Array(0);
  let store = null;

  const cellCoord = (v) => { const c = (v / cellSize) | 0; return c < 0 ? 0 : c >= cells ? cells - 1 : c; };

  const hash = {
    count: 0,
    rebuild(e) {
      store = e;
      if (entries.length < e.cap) { entries = new Int32Array(e.cap); cellOf = new Int32Array(e.cap); }
      cellStart.fill(0);
      for (let i = 0; i < e.high; i++) {
        if (!e.alive[i]) continue;
        const c = cellCoord(e.z[i]) * cells + cellCoord(e.x[i]);
        cellOf[i] = c;
        cellStart[c + 1]++;
      }
      for (let c = 0; c < cells * cells; c++) cellStart[c + 1] += cellStart[c];
      hash.count = cellStart[cells * cells];
      // Second pass fills each cell's span in ascending entity order.
      const cursor = cellStart.slice(0, cells * cells);
      for (let i = 0; i < e.high; i++) {
        if (!e.alive[i]) continue;
        entries[cursor[cellOf[i]]++] = i;
      }
    },
    /** Calls fn(index, squaredDistance) for every live creature within r of (x, z). */
    forEachInRadius(x, z, r, fn) {
      const e = store;
      const r2 = r * r;
      const cx0 = cellCoord(x - r); const cx1 = cellCoord(x + r);
      const cz0 = cellCoord(z - r); const cz1 = cellCoord(z + r);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cz * cells + cx;
          for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
            const i = entries[k];
            // The grid is built once per tick, so an entity killed earlier in the same
            // tick is still in it. Skip the dead: a corpse must not join a herd, lead a
            // pack, take a share of a kill, or be chosen as prey or a mate.
            if (!e.alive[i]) continue;
            const dx = e.x[i] - x; const dz = e.z[i] - z;
            const d2 = dx * dx + dz * dz;
            if (d2 <= r2) fn(i, d2);
          }
        }
      }
    },
  };
  return hash;
}
