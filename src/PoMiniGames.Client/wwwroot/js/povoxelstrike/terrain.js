// terrain.js — fine-grained, DIGGABLE block terrain for the arena (seeded).
//
// 0.2-unit voxels on a 900×900 column grid (10× the detail of the original 2-unit
// blocks). At this density a naive face-per-block mesh is ~5M triangles, so each chunk
// is GREEDY-MESHED: same-height, same-tint top areas merge into single quads and cliff
// walls merge into runs — flat meadows cost almost nothing, and only the contour edges
// spend triangles. Color jitter is quantized to coarse patches for the same reason.
//
// Collision stays a cannon-es Heightfield sampled at a 10-cell stride (2-unit elements,
// height = MAX of the covered columns) — debris does not need 0.2-unit fidelity, and a
// 900² heightfield would be megabytes of pillar cache.
//
// Weapons dig it: dig() drops columns inside a carve sphere, dug ground exposes dirt
// (top metre) then stone, and only touched chunks re-mesh. Gameplay reads the surface
// through heightAt() / raycast().

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// Declared here (not world.js) so this module has no import back into world.js — world.js
// imports Terrain, and a top-level back-reference would hit the TDZ mid-evaluation.
export const ARENA_HALF = 90; // playable square is [-ARENA_HALF, ARENA_HALF] on X/Z

const BLOCK = 0.2;               // world units per voxel (cube side)
const MAX_LEVEL = 50;            // tallest hill = 10 world units, in 0.2 steps
const CELLS = Math.round((ARENA_HALF * 2) / BLOCK); // 900 → 900×900 columns
const CHUNK_CELLS = 60;          // 12×12 world units per chunk → 15×15 chunks
const CHUNKS = Math.ceil(CELLS / CHUNK_CELLS);
const DIRT_BAND = 5;             // levels of dirt (1 unit) before digging hits stone
const PHYS_STRIDE = 10;          // heightfield samples every 10 columns (2-unit elements)
const PHYS_N = CELLS / PHYS_STRIDE;

const GRASS = new THREE.Color(0x4c8f46);
const DIRT = new THREE.Color(0x6d5138);
const STONE = new THREE.Color(0x63656b);
const SHADES = 8;                // quantized jitter steps (coarse patches share a shade)

export class Terrain {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.levels = new Int8Array(CELLS * CELLS);
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        // Same world-space wavelengths as the coarse terrain (32u hills + 11u detail).
        const n = 0.7 * valueNoise(i / 160, j / 160, this.seed)
          + 0.3 * valueNoise(i / 55, j / 55, this.seed ^ 0x9e3779b9);
        this.levels[i + j * CELLS] = Math.min(MAX_LEVEL, Math.max(0, Math.round(n * (MAX_LEVEL + 10) - 2.5)));
      }
    }
    // Frozen pre-dig snapshot: original surface keeps grass; dug ground exposes dirt,
    // then stone — the contrast that makes craters read as craters.
    this.originalLevels = null;

    this.group = null;
    this.chunkMeshes = new Map(); // "ci,cj" -> Mesh
    this.dirtyChunks = new Set();
    this.material = null;
    this.body = null;
    this.colliderDirty = false;
    this.scene = null;
    this.physicsWorld = null;
  }

  _cell(x, z) {
    const i = Math.min(CELLS - 1, Math.max(0, Math.floor((x + ARENA_HALF) / BLOCK)));
    const j = Math.min(CELLS - 1, Math.max(0, Math.floor((z + ARENA_HALF) / BLOCK)));
    return [i, j];
  }

  /** Exact stepped surface height (world y) under a world x/z. */
  heightAt(x, z) {
    const [i, j] = this._cell(x, z);
    return this.levels[i + j * CELLS] * BLOCK;
  }

  /**
   * Flatten a disc to the level at its center — the build pad under a structure (and
   * the player spawn). Must run BEFORE build(); pads still count as "original" ground.
   */
  flatten(x, z, radius) {
    const [ci, cj] = this._cell(x, z);
    const level = this.levels[ci + cj * CELLS];
    const r = Math.ceil(radius / BLOCK);
    for (let j = Math.max(0, cj - r); j <= Math.min(CELLS - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(CELLS - 1, ci + r); i++) {
        if ((i - ci) * (i - ci) + (j - cj) * (j - cj) <= r * r) {
          this.levels[i + j * CELLS] = level;
        }
      }
    }
    return level * BLOCK;
  }

  // ── Digging ────────────────────────────────────────────────────────────

  /**
   * Carve a sphere out of the ground: every column whose surface the sphere reaches
   * drops to the sphere's lower boundary. Returns the number of voxels removed.
   */
  dig(point, radius) {
    const [ci, cj] = this._cell(point.x, point.z);
    const r = Math.ceil(radius / BLOCK) + 1;
    let removed = 0;

    for (let j = Math.max(0, cj - r); j <= Math.min(CELLS - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(CELLS - 1, ci + r); i++) {
        const cx = -ARENA_HALF + (i + 0.5) * BLOCK;
        const cz = -ARENA_HALF + (j + 0.5) * BLOCK;
        const d2 = (cx - point.x) ** 2 + (cz - point.z) ** 2;
        if (d2 > radius * radius) continue;

        const drop = Math.sqrt(radius * radius - d2);
        const level = this.levels[i + j * CELLS];
        if (point.y - drop >= level * BLOCK) continue; // sphere never reaches this column
        const newLevel = Math.max(0, Math.min(level, Math.floor((point.y - drop) / BLOCK + 0.02)));
        if (newLevel >= level) continue;

        removed += level - newLevel;
        this.levels[i + j * CELLS] = newLevel;
        this._markDirty(i, j);
      }
    }
    if (removed > 0) this.colliderDirty = true;
    return removed;
  }

  /** Ray-marched surface hit. @returns {{distance:number, point:THREE.Vector3}|null} */
  raycast(origin, direction, maxDistance) {
    const step = 0.35;
    const p = origin.clone();
    for (let t = step; t <= maxDistance; t += step) {
      p.copy(origin).addScaledVector(direction, t);
      if (Math.abs(p.x) > ARENA_HALF + 4 || Math.abs(p.z) > ARENA_HALF + 4) continue;
      if (p.y <= this.heightAt(p.x, p.z)) {
        let lo = t - step, hi = t;
        for (let n = 0; n < 5; n++) {
          const mid = (lo + hi) / 2;
          p.copy(origin).addScaledVector(direction, mid);
          if (p.y <= this.heightAt(p.x, p.z)) hi = mid; else lo = mid;
        }
        p.copy(origin).addScaledVector(direction, hi);
        return { distance: hi, point: p.clone() };
      }
    }
    return null;
  }

  // ── Meshes (chunked + greedy) + collider ───────────────────────────────

  build(scene, physicsWorld) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.originalLevels = new Int8Array(this.levels); // grass baseline, frozen post-pads
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.group = new THREE.Group();
    scene.add(this.group);

    for (let cj = 0; cj < CHUNKS; cj++) {
      for (let ci = 0; ci < CHUNKS; ci++) {
        this.dirtyChunks.add(`${ci},${cj}`);
      }
    }
    this.rebuildDirty();

    this.colliderDirty = true;
    this.rebuildCollider();
  }

  _markDirty(i, j) {
    const ci = Math.floor(i / CHUNK_CELLS), cj = Math.floor(j / CHUNK_CELLS);
    this.dirtyChunks.add(`${ci},${cj}`);
    // A border dig changes the neighbour chunk's exposed walls too.
    if (i % CHUNK_CELLS === 0) this.dirtyChunks.add(`${ci - 1},${cj}`);
    if (i % CHUNK_CELLS === CHUNK_CELLS - 1) this.dirtyChunks.add(`${ci + 1},${cj}`);
    if (j % CHUNK_CELLS === 0) this.dirtyChunks.add(`${ci},${cj - 1}`);
    if (j % CHUNK_CELLS === CHUNK_CELLS - 1) this.dirtyChunks.add(`${ci},${cj + 1}`);
  }

  rebuildDirty() {
    for (const key of this.dirtyChunks) {
      const [ci, cj] = key.split(',').map(Number);
      if (ci < 0 || cj < 0 || ci >= CHUNKS || cj >= CHUNKS) continue;
      const old = this.chunkMeshes.get(key);
      if (old) { this.group.remove(old); old.geometry.dispose(); this.chunkMeshes.delete(key); }
      const geometry = this._buildChunkGeometry(ci * CHUNK_CELLS, cj * CHUNK_CELLS);
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, this.material);
      // Ground receives building/debris shadows; casting from 810k m² of terrain would
      // only cost shadow-map fill for self-shadowing the height steps barely show.
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.chunkMeshes.set(key, mesh);
    }
    this.dirtyChunks.clear();
  }

  rebuildCollider() {
    if (!this.colliderDirty || !this.physicsWorld) return;
    this.colliderDirty = false;
    if (this.body) this.physicsWorld.removeBody(this.body);

    // Vertex (i,j) covers fine columns [ (i-1)·S, i·S ] × the j-flipped row band —
    // the same corner mapping the coarse terrain used, scaled by the stride. MAX over
    // the region keeps debris resting ON block tops, never sunk into stair edges.
    const data = [];
    for (let i = 0; i <= PHYS_N; i++) {
      const column = [];
      for (let j = 0; j <= PHYS_N; j++) {
        let max = 0;
        const fi0 = Math.max(0, (i - 1) * PHYS_STRIDE), fi1 = Math.min(CELLS - 1, i * PHYS_STRIDE);
        const fj0 = Math.max(0, CELLS - j * PHYS_STRIDE - PHYS_STRIDE), fj1 = Math.min(CELLS - 1, CELLS - j * PHYS_STRIDE);
        for (let fj = fj0; fj <= fj1; fj++) {
          for (let fi = fi0; fi <= fi1; fi++) {
            const v = this.levels[fi + fj * CELLS];
            if (v > max) max = v;
          }
        }
        column.push(max * BLOCK);
      }
      data.push(column);
    }
    const shape = new CANNON.Heightfield(data, { elementSize: PHYS_STRIDE * BLOCK });
    this.body = new CANNON.Body({ type: CANNON.Body.STATIC });
    this.body.addShape(shape);
    this.body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.body.position.set(-ARENA_HALF, 0, ARENA_HALF);
    this.physicsWorld.addBody(this.body);
  }

  /** Top-face merge key: level + dug-material bucket + quantized shade patch. */
  _topKey(i, j) {
    const idx = i + j * CELLS;
    const level = this.levels[idx];
    const dug = this.originalLevels[idx] - level;
    const bucket = dug <= 0 ? 0 : dug <= DIRT_BAND ? 1 : 2;
    const shade = Math.floor(hash(i >> 5, j >> 5, this.seed ^ 0x51ed2701) * SHADES);
    return (level * 3 + bucket) * SHADES + shade;
  }

  _topColor(i, j, tint) {
    const idx = i + j * CELLS;
    const dug = this.originalLevels[idx] - this.levels[idx];
    const shade = Math.floor(hash(i >> 5, j >> 5, this.seed ^ 0x51ed2701) * SHADES);
    tint.copy(dug <= 0 ? GRASS : dug <= DIRT_BAND ? DIRT : STONE)
      .multiplyScalar(0.92 + (shade / SHADES) * 0.16);
  }

  _buildChunkGeometry(i0, j0) {
    const w = Math.min(CHUNK_CELLS, CELLS - i0);
    const h = Math.min(CHUNK_CELLS, CELLS - j0);
    const positions = [], normals = [], colors = [];
    const levelOf = (i, j) =>
      (i < 0 || j < 0 || i >= CELLS || j >= CELLS) ? 0 : this.levels[i + j * CELLS];
    const wx = (i) => -ARENA_HALF + i * BLOCK;
    const wz = (j) => -ARENA_HALF + j * BLOCK;

    const quad = (corners, normal, color) => {
      for (const c of [0, 1, 2, 0, 2, 3]) {
        positions.push(corners[c][0], corners[c][1], corners[c][2]);
        normals.push(normal[0], normal[1], normal[2]);
        colors.push(color.r, color.g, color.b);
      }
    };
    const tint = new THREE.Color();

    // ── Tops: 2D greedy merge over (level, material, shade) ──────────────
    const keys = new Int32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        keys[i + j * w] = this._topKey(i0 + i, j0 + j);
      }
    }
    const done = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (done[i + j * w]) continue;
        const key = keys[i + j * w];
        let rw = 1;
        while (i + rw < w && !done[i + rw + j * w] && keys[i + rw + j * w] === key) rw++;
        let rh = 1;
        expand: while (j + rh < h) {
          for (let k = 0; k < rw; k++) {
            if (done[i + k + (j + rh) * w] || keys[i + k + (j + rh) * w] !== key) break expand;
          }
          rh++;
        }
        for (let jj = 0; jj < rh; jj++) for (let ii = 0; ii < rw; ii++) done[i + ii + (jj + j) * w] = 1;

        const y = levelOf(i0 + i, j0 + j) * BLOCK;
        this._topColor(i0 + i, j0 + j, tint);
        const x0 = wx(i0 + i), x1 = wx(i0 + i + rw), z0 = wz(j0 + j), z1 = wz(j0 + j + rh);
        quad([[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], [0, 1, 0], tint);
      }
    }

    // ── Walls: run-merged along their axis; dirt band on top, stone below ─
    // Winding pairs (c0, c1) verified CCW-from-outside per direction.
    const wall = (loLevel, hiLevel, c0, c1, normal) => {
      const dirtLo = Math.max(loLevel, hiLevel - DIRT_BAND);
      if (dirtLo > loLevel) {
        tint.copy(STONE);
        quad([
          [c0[0], loLevel * BLOCK, c0[1]], [c1[0], loLevel * BLOCK, c1[1]],
          [c1[0], dirtLo * BLOCK, c1[1]], [c0[0], dirtLo * BLOCK, c0[1]],
        ], normal, tint);
      }
      tint.copy(DIRT);
      quad([
        [c0[0], dirtLo * BLOCK, c0[1]], [c1[0], dirtLo * BLOCK, c1[1]],
        [c1[0], hiLevel * BLOCK, c1[1]], [c0[0], hiLevel * BLOCK, c0[1]],
      ], normal, tint);
    };

    // X-facing walls: boundary owned by the higher cell inside this chunk; runs along j.
    for (let i = 0; i < w; i++) {
      const gi = i0 + i;
      for (const side of [1, -1]) {
        let j = 0;
        while (j < h) {
          const L = levelOf(gi, j0 + j), N = levelOf(gi + side, j0 + j);
          if (L <= N) { j++; continue; }
          let run = 1;
          while (j + run < h
            && levelOf(gi, j0 + j + run) === L
            && levelOf(gi + side, j0 + j + run) === N) run++;
          const xB = side === 1 ? wx(gi + 1) : wx(gi);
          const za = wz(j0 + j), zb = wz(j0 + j + run);
          if (side === 1) wall(N, L, [xB, zb], [xB, za], [1, 0, 0]);
          else wall(N, L, [xB, za], [xB, zb], [-1, 0, 0]);
          j += run;
        }
      }
    }
    // Z-facing walls: runs along i.
    for (let j = 0; j < h; j++) {
      const gj = j0 + j;
      for (const side of [1, -1]) {
        let i = 0;
        while (i < w) {
          const L = levelOf(i0 + i, gj), N = levelOf(i0 + i, gj + side);
          if (L <= N) { i++; continue; }
          let run = 1;
          while (i + run < w
            && levelOf(i0 + i + run, gj) === L
            && levelOf(i0 + i + run, gj + side) === N) run++;
          const zB = side === 1 ? wz(gj + 1) : wz(gj);
          const xa = wx(i0 + i), xb = wx(i0 + i + run);
          if (side === 1) wall(N, L, [xa, zB], [xb, zB], [0, 0, 1]);
          else wall(N, L, [xb, zB], [xa, zB], [0, 0, -1]);
          i += run;
        }
      }
    }

    if (positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geometry;
  }

  dispose(scene, physicsWorld) {
    for (const mesh of this.chunkMeshes.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunkMeshes.clear();
    this.material?.dispose();
    if (this.group) scene.remove(this.group);
    if (this.body) physicsWorld.removeBody(this.body);
  }
}

// ── Seeded value noise ─────────────────────────────────────────────────────

function hash(ix, iz, seed) {
  let h = (ix | 0) * 374761393 + (iz | 0) * 668265263 + (seed | 0) * 974634721;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx); // smoothstep
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz, seed), b = hash(ix + 1, iz, seed);
  const c = hash(ix, iz + 1, seed), d = hash(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
