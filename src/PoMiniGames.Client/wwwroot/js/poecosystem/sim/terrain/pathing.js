// pathing.js — grid distance fields. Creatures never run A*: they descend a BFS field
// (water, home) or the heightmap (rocks), which is cheap, allocation-free per query and
// deterministic because neighbour order is fixed.
import { NEIGHBOURS4, NEIGHBOURS8, isWalkable, isWater, tileX, tileZ } from './tiles.js';

/** Walkable tiles with a 4-neighbour water tile — where a creature can drink. */
export function shoreTiles(terrain) {
  const { size, type } = terrain;
  const out = [];
  for (let i = 0; i < type.length; i++) {
    if (!isWalkable(type[i])) continue;
    const x = tileX(i, size); const z = tileZ(i, size);
    for (const [dx, dz] of NEIGHBOURS4) {
      const nx = x + dx; const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      if (isWater(type[nz * size + nx])) { out.push(i); break; }
    }
  }
  return out;
}

/**
 * Multi-source 4-neighbour BFS. Returns Int32Array of distances in tiles; -1 where
 * unreachable or not passable. `passable(i)` decides which tiles the field flows through.
 */
export function bfsDistanceField(terrain, sources, passable) {
  const { size } = terrain;
  const n = size * size;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0; let tail = 0;
  for (const s of sources) if (passable(s) && dist[s] < 0) { dist[s] = 0; queue[tail++] = s; }
  while (head < tail) {
    const i = queue[head++];
    const x = tileX(i, size); const z = tileZ(i, size);
    for (const [dx, dz] of NEIGHBOURS4) {
      const nx = x + dx; const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      const j = nz * size + nx;
      if (dist[j] >= 0 || !passable(j)) continue;
      dist[j] = dist[i] + 1;
      queue[tail++] = j;
    }
  }
  return dist;
}

/** Next tile toward the field's sources (strictly smaller distance), or `i` when at 0 / stranded. */
export function descendStep(terrain, field, i) {
  const { size } = terrain;
  const x = tileX(i, size); const z = tileZ(i, size);
  let best = i; let bestD = field[i];
  for (const [dx, dz] of NEIGHBOURS4) {
    const nx = x + dx; const nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
    const j = nz * size + nx;
    const d = field[j];
    if (d >= 0 && d < bestD) { best = j; bestD = d; }
  }
  return best;
}

/** Lowest 8-neighbour by tile height, or `i` in a basin. Used for rock corridors and lava. */
export function downhillNeighbour(terrain, i) {
  const { size } = terrain;
  const x = tileX(i, size); const z = tileZ(i, size);
  let best = i; let bestH = terrain.tileHeight(i);
  for (const [dx, dz] of NEIGHBOURS8) {
    const nx = x + dx; const nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
    const j = nz * size + nx;
    const h = terrain.tileHeight(j);
    if (h < bestH) { best = j; bestH = h; }
  }
  return best;
}
