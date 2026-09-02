// island.js — seeded procedural island: a corner heightmap (size+1)² in metres and a
// per-tile biome. Sea level is 0. The generator is pure and deterministic; its output
// hash is stored in snapshots so a changed generator invalidates old saves rather than
// dropping creatures under a different terrain.
import { WORLD_SIZE } from '../core/config.js';
import { fbm } from './noise.js';
import { NEIGHBOURS4, TILE, isWalkable, isWater, tileIndex, tileX, tileZ } from './tiles.js';

// Shape parameters (tuned on seeds 1–8 for a 0.45–0.75 walkable ratio).
const P = Object.freeze({
  heightScale: 27,       // metres for the noisiest peak before the volcano raise
  baseFreq: 0.014,       // tiles → noise units for the base relief
  coastRadius: 0.66,     // where the radial mask starts falling (0 = centre, 1 = edge midpoint)
  coastWidth: 0.34,      // mask fade distance
  coastWobble: 0.16,     // coastline irregularity from a second noise
  beachMax: 1.4,
  grassMax: 11.5,
  hillMax: 17.5,
  mountainCapDepth: 3.5, // tiles this close to the summit height (and within mountainCapRadius) are mountain
  mountainCapRadius: 10,
  forestThreshold: 0.56,
  lakeThreshold: 0.715,
  lakeMinHeight: 1.6,
  lakeMaxHeight: 9,
  minLakeTiles: 20,
  volcanoRaise: 6,
});

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function generateIsland(seed, size = WORLD_SIZE) {
  const cs = size + 1;
  const height = new Float32Array(cs * cs);
  const type = new Uint8Array(size * size);
  const tileH = new Float32Array(size * size);
  const half = size / 2;

  // 1. Corner heights: relief × radial mask, forced under water at the rim.
  for (let cz = 0; cz < cs; cz++) {
    for (let cx = 0; cx < cs; cx++) {
      const nx = (cx - half) / half; const nz = (cz - half) / half;
      const d = Math.sqrt(nx * nx + nz * nz);
      const wobble = (fbm(nx * 2.1 + 7.3, nz * 2.1 - 3.1, seed ^ 0x51ed, 3) - 0.5) * P.coastWobble;
      const mask = 1 - smoothstep(P.coastRadius, P.coastRadius + P.coastWidth, d + wobble);
      const relief = fbm(cx * P.baseFreq, cz * P.baseFreq, seed, 5);
      let h = (relief * 1.35 - 0.33) * mask * P.heightScale - (1 - mask) * 6;
      if (cx === 0 || cz === 0 || cx === size || cz === size || d > 1.02) h = Math.min(h, -3);
      height[cz * cs + cx] = h;
    }
  }

  const cornerAvg = (i) => {
    const x = tileX(i, size); const z = tileZ(i, size);
    const o = z * cs + x;
    return (height[o] + height[o + 1] + height[o + cs] + height[o + cs + 1]) * 0.25;
  };
  const setTileCorners = (i, fn) => {
    const x = tileX(i, size); const z = tileZ(i, size);
    const o = z * cs + x;
    for (const k of [o, o + 1, o + cs, o + cs + 1]) height[k] = fn(height[k]);
  };
  const refreshTileH = () => { for (let i = 0; i < tileH.length; i++) tileH[i] = cornerAvg(i); };
  refreshTileH();

  // 2. Lakes: inland basins from a low-frequency noise, flattened to sea level.
  const lake = new Uint8Array(size * size);
  for (let i = 0; i < lake.length; i++) {
    const h = tileH[i];
    if (h < P.lakeMinHeight || h > P.lakeMaxHeight) continue;
    const x = tileX(i, size); const z = tileZ(i, size);
    if (fbm(x * 0.028 + 11, z * 0.028 - 5, seed ^ 0x1a4e, 3) > P.lakeThreshold) lake[i] = 1;
  }
  // Drop lake tiles that touch the map rim's ocean (they would just be bays).
  for (let i = 0; i < lake.length; i++) if (lake[i]) setTileCorners(i, (h) => Math.min(h, 0));
  refreshTileH();
  let lakeCount = 0;
  for (let i = 0; i < lake.length; i++) lakeCount += lake[i];
  if (lakeCount < P.minLakeTiles) {
    // Carve one at the tile farthest from any water (deterministic BFS from the ocean).
    const dist = distanceFromWater(size, tileH, lake);
    let best = -1; let bestD = -1;
    for (let i = 0; i < dist.length; i++) if (dist[i] > bestD && tileH[i] >= 1 && tileH[i] <= 25) { bestD = dist[i]; best = i; }
    const bx = tileX(best, size); const bz = tileZ(best, size);
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      if (dx * dx + dz * dz > 9) continue;
      const i = tileIndex(bx + dx, bz + dz, size);
      lake[i] = 1;
      setTileCorners(i, (h) => Math.min(h, 0));
    }
    refreshTileH();
  }

  // 3. Volcano: the summit tile, raised into a cone.
  let volcanoTile = 0;
  for (let i = 1; i < tileH.length; i++) if (tileH[i] > tileH[volcanoTile]) volcanoTile = i;
  setTileCorners(volcanoTile, (h) => h + P.volcanoRaise);
  refreshTileH();

  // 4. Biomes from the final heights. The mountain line is relative to the summit so a
  // gentle seed still gets a rocky cap around its volcano.
  let maxHeight = -Infinity;
  for (let i = 0; i < tileH.length; i++) if (tileH[i] > maxHeight) maxHeight = tileH[i];
  const summitBase = maxHeight - P.volcanoRaise;
  const vx = tileX(volcanoTile, size); const vz = tileZ(volcanoTile, size);
  const nearSummit = (i, h) => {
    if (h < summitBase - P.mountainCapDepth) return false;
    const dx = tileX(i, size) - vx; const dz = tileZ(i, size) - vz;
    return dx * dx + dz * dz <= P.mountainCapRadius * P.mountainCapRadius;
  };
  for (let i = 0; i < type.length; i++) {
    const h = tileH[i];
    if (lake[i]) { type[i] = TILE.LAKE; continue; }
    if (h < 0) type[i] = TILE.OCEAN;
    else if (h < P.beachMax) type[i] = TILE.BEACH;
    else if (h < P.grassMax) {
      const x = tileX(i, size); const z = tileZ(i, size);
      type[i] = fbm(x * 0.045 + 3, z * 0.045 + 9, seed ^ 0xf0e5, 3) > P.forestThreshold ? TILE.FOREST : TILE.GRASS;
    } else if (h < P.hillMax && !nearSummit(i, h)) type[i] = TILE.HILL;
    else type[i] = TILE.MOUNTAIN;
  }
  type[volcanoTile] = TILE.VOLCANO;
  // Rim tiles are always ocean (their corners were forced negative above).
  for (let i = 0; i < size; i++) {
    type[tileIndex(i, 0, size)] = TILE.OCEAN; type[tileIndex(i, size - 1, size)] = TILE.OCEAN;
    type[tileIndex(0, i, size)] = TILE.OCEAN; type[tileIndex(size - 1, i, size)] = TILE.OCEAN;
  }

  // 5. Content hash (FNV-1a over biomes + centimetre heights).
  let hash = 0x811C9DC5;
  const mix = (v) => { hash ^= v & 0xff; hash = Math.imul(hash, 0x01000193); };
  for (let i = 0; i < type.length; i++) mix(type[i]);
  for (let i = 0; i < height.length; i++) { const q = Math.round(height[i] * 100) | 0; mix(q); mix(q >> 8); mix(q >> 16); }
  hash >>>= 0;

  const terrain = {
    seed, size, height, type, tileH, volcanoTile, maxHeight, hash,
    tileHeight: (i) => tileH[i],
    /** Bilinear height at a world position (metres); outside the map is ocean. */
    heightAt(x, z) {
      if (x < 0 || z < 0 || x > size || z > size) return -3;
      const ix = Math.min(size - 1, Math.floor(x)); const iz = Math.min(size - 1, Math.floor(z));
      const fx = x - ix; const fz = z - iz;
      const o = iz * cs + ix;
      const top = height[o] + (height[o + 1] - height[o]) * fx;
      const bottom = height[o + cs] + (height[o + cs + 1] - height[o + cs]) * fx;
      return top + (bottom - top) * fz;
    },
    typeAt: (x, z) => type[tileIndex(x, z, size)],
  };
  return terrain;
}

/** 4-neighbour BFS distance (in tiles) from any water tile, over land. */
function distanceFromWater(size, tileH, lake) {
  const n = size * size;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0; let tail = 0;
  for (let i = 0; i < n; i++) if (tileH[i] < 0 || lake[i]) { dist[i] = 0; queue[tail++] = i; }
  while (head < tail) {
    const i = queue[head++];
    const x = tileX(i, size); const z = tileZ(i, size);
    for (const [dx, dz] of NEIGHBOURS4) {
      const nx = x + dx; const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      const j = nz * size + nx;
      if (dist[j] >= 0) continue;
      dist[j] = dist[i] + 1;
      queue[tail++] = j;
    }
  }
  return dist;
}

export { isWalkable, isWater };
