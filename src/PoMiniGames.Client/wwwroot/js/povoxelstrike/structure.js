// structure.js — a placed, destructible voxel structure (PRD §F5).
//
// Owns the mutable voxel grid, its chunked render meshes, its coarse static collision
// body, and the structural-support solver. The stress model is the PRD's load-bearing
// option made cheap enough for a per-click budget: support propagates from grounded
// voxels — full strength straight up a column, decaying per lateral/hanging step — and
// any solid voxel the propagation cannot reach fails. That expresses both "no load path
// to the ground" (severed) and "cantilever exceeds material strength" (too far from a
// support column) in one BFS, at ~2-5 ms for a typical asset.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { createVoxelMaterial } from './materials.js';
import { greedyBoxes } from './voxelboxes.js';
import { GRAVITY, materialFor, surfaceOf, MATERIAL_PRESETS } from './physics.js';

// Render-mesh rebuild granularity, in voxels. Doubled alongside world.js's REFINE = 2 to
// keep the same world-space chunk size; at 16 the refined grid would give 8x the chunks
// for no extra fidelity.
const CHUNK = 32;

// Collision is built by greedy-merging the ACTUAL solid voxels (voxelboxes.js), one
// static body per chunk, rather than stamping a box wherever an 8-voxel block had
// anything in it. That old lattice was 2 m across on a 0.25 m wall, so a blasted opening
// still collided as solid for two metres in every direction.
const COLLIDER_BOX_BUDGET = 96;   // per chunk; voxelboxes.js coarsens rather than truncates

// Bucket range for the support solve. Lateral step cost is derived per material from its
// bending capacity, so this is a resolution, not a distance: a material that cantilevers
// a long way pays 1 per step and gets all 64 of them, a weak one pays more per step.
const SUPPORT_RESOLUTION = 64;
// Section depth assumed when converting tensile strength into a cantilever length. A real
// bending calculation needs the local depth; sampling the true thickness per voxel would
// cost more than the whole solve, and 4 voxels is the order of a wall leaf.

const BENDING_DEPTH_VOXELS = 4;

// Fracture. ROUGHNESS is the fraction by which the crater radius wanders; the wavelength
// is fixed at 4 voxels by the `>> 2` in the carve loop, which is coarse enough to read as
// broken masonry rather than as noise on the surface.
const FRACTURE_ROUGHNESS = 0.22;
const FRACTURE_MIN_VOXELS = 220;      // below this the debris system bursts it anyway
const FRACTURE_VOXELS_PER_PIECE = 190;
const FRACTURE_MAX_PIECES = 8;        // caps the body count one collapse can produce

/** Stable 3D value hash in [0,1). Same generator as the terrain's, one dimension up. */
function hash3(x, y, z) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Cantilever reach for a material, in VOXELS -- derived, not tuned.
//
// A cantilever fails in bending, not pure tension: for a beam of length L and section
// depth d carrying only its own weight, peak fibre stress is 3*rho*g*L^2/d. Set that
// equal to the material's tensile strength and solve for L and you get the longest
// unsupported span it holds. Stone (2 MPa tensile, 2400 kg/m3) over a 1 m section gives
// 5.3 m, which is about what a real stone corbel manages and is why battlements can
// overhang at all. Oak comes out in the tens of metres, so timber framing effectively
// never snaps under its own weight -- also correct.
function cantileverVoxels(material, scale) {
  const depth = BENDING_DEPTH_VOXELS * scale;
  const tensile = material?.tensile ?? MATERIAL_PRESETS.stone.tensile;
  const density = material?.density ?? MATERIAL_PRESETS.stone.density;
  return Math.max(1, Math.sqrt((tensile * depth) / (3 * density * GRAVITY)) / scale);
}

const FACES = [
  { d: [1, 0, 0], n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { d: [-1, 0, 0], n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { d: [0, 1, 0], n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { d: [0, -1, 0], n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { d: [0, 0, 1], n: [0, 0, 1], c: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { d: [0, 0, -1], n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

export class Structure {
  /**
   * @param volume decoded pvx volume (cells are COPIED — instances carve independently)
   * @param scale world units per voxel
   * @param terrain optional — lets the support solver notice when the ground under a
   *   base column has been dug away (undermining). Without it, grid y=0 is
   *   unconditionally "the ground" and an undermined building floats.
   */
  constructor(volume, scale, position, rotationY, scene, physicsWorld, terrain = null,
    physicsMaterials = null) {
    this.terrain = terrain;
    this.dims = volume.dims;
    this.palette = volume.palette;
    // The material table travels with the structure now: mass, cantilever reach, crush
    // threshold, carve resistance and contact surface all read from it.
    this.volume = { materials: volume.materials, paletteMaterial: volume.paletteMaterial };
    this.materialTable = volume.materials ?? [MATERIAL_PRESETS.stone];
    this.cells = new Uint8Array(volume.cells); // per-instance copy
    this.scale = scale;
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.solidCount = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] !== 0) this.solidCount++;

    const [nx, , nz] = this.dims;
    this.cx = nx / 2;
    this.cz = nz / 2;

    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.group.rotation.y = rotationY;
    this.group.scale.setScalar(scale);
    scene.add(this.group);
    this.group.updateMatrixWorld(true);
    this.inverseMatrix = this.group.matrixWorld.clone().invert();

    this.material = createVoxelMaterial();
    this.chunkMeshes = new Map(); // chunkKey -> Mesh
    this.dirtyChunks = new Set();
    for (const key of this._allChunkKeys()) this.dirtyChunks.add(key);
    this.rebuildDirtyChunks();

    // One static body PER CHUNK rather than one for the whole structure: the broadphase
    // can cull a chunk, and a carve rebuilds only the chunks it touched instead of
    // regenerating the entire collider on every shot.
    this.colliderBodies = new Map(); // chunkKey -> CANNON.Body
    this.colliderDirtyChunks = new Set();
    for (const key of this._allChunkKeys()) this.colliderDirtyChunks.add(key);
    this.colliderDirty = true;

    // Per-palette-entry tables for the stress solve. There are a handful of palette
    // entries and millions of voxels, so this turns a per-voxel sqrt into a lookup.
    const entries = Math.max(1, Math.floor((volume.palette?.length ?? 4) / 4));
    this.stepCost = new Uint8Array(entries + 1);
    this.crushStress = new Float32Array(entries + 1);
    this.voxelWeight = new Float32Array(entries + 1); // newtons per voxel
    for (let v = 1; v <= entries; v++) {
      const m = materialFor(this.volume, v);
      this.stepCost[v] = Math.max(1,
        Math.round(SUPPORT_RESOLUTION / cantileverVoxels(m, this.scale)));
      this.crushStress[v] = m.compressive ?? MATERIAL_PRESETS.stone.compressive;
      this.voxelWeight[v] = (m.density ?? 2400) * this.scale ** 3 * GRAVITY;
    }
    // How far a blast eats into each material, relative to stone. Compressive strength
    // to the quarter power: a 4x weaker material takes a ~40% wider crater, not a 4x one,
    // because the blast energy spreads over a sphere. Plaster shatters, oak resists.
    this.carveMult = new Float32Array(entries + 1);
    for (let v = 1; v <= entries; v++) {
      this.carveMult[v] = Math.min(1.6, Math.max(0.75,
        (MATERIAL_PRESETS.stone.compressive / this.crushStress[v]) ** 0.25));
    }
    this.surface = surfaceOf(this.materialTable[0]);
    this.physicsMaterial = physicsMaterials ? physicsMaterials[this.surface] : undefined;

    this.rebuildCollider();
  }

  at(x, y, z) {
    const [nx, ny, nz] = this.dims;
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return 0;
    return this.cells[x + y * nx + z * nx * ny];
  }

  // ── Carving ────────────────────────────────────────────────────────────

  /**
   * Remove all voxels within worldRadius of worldPoint, then re-solve support and
   * detach whatever fails. Returns { removed:[{x,y,z,value}], clusters:[cluster] }
   * where each cluster is { voxels:[{x,y,z,value}], … } of NEWLY unsupported voxels
   * (already removed from this grid) for the caller to turn into debris.
   */
  carveSphere(worldPoint, worldRadius) {
    const local = worldPoint.clone().applyMatrix4(this.inverseMatrix);
    const vx = local.x + this.cx, vy = local.y, vz = local.z + this.cz;
    const r = worldRadius / this.scale;
    const [nx, ny, nz] = this.dims;
    const removed = [];

    // The crater is NOT a sphere. Two things break it up, and both are physical rather
    // than decorative:
    //   * material -- weak plaster is eaten further out than dense stone (carveMult);
    //   * fracture -- masonry fails along faults, so the boundary is perturbed by a
    //     coherent hash at a ~4-voxel wavelength. Chunks come off angular, and repeated
    //     hits on one spot no longer stack into a machined hemisphere.
    // The scan box is grown by the largest possible multiplier so the widened side of an
    // irregular crater is never clipped by the loop bounds.
    const reach = r * 1.6 * (1 + FRACTURE_ROUGHNESS);
    for (let z = Math.max(0, Math.floor(vz - reach)); z <= Math.min(nz - 1, Math.ceil(vz + reach)); z++) {
      for (let y = Math.max(0, Math.floor(vy - reach)); y <= Math.min(ny - 1, Math.ceil(vy + reach)); y++) {
        for (let x = Math.max(0, Math.floor(vx - reach)); x <= Math.min(nx - 1, Math.ceil(vx + reach)); x++) {
          const i = x + y * nx + z * nx * ny;
          const value = this.cells[i];
          if (value === 0) continue;
          const dx = x + 0.5 - vx, dy = y + 0.5 - vy, dz = z + 0.5 - vz;
          const d2 = dx * dx + dy * dy + dz * dz;
          const rough = 1 + FRACTURE_ROUGHNESS * (hash3(x >> 2, y >> 2, z >> 2) * 2 - 1);
          const rr = r * (this.carveMult[value] ?? 1) * rough;
          if (d2 > rr * rr) continue;
          removed.push({ x, y, z, value });
          this.cells[i] = 0;
          this.solidCount--;
          this._markDirty(x, y, z);
        }
      }
    }
    if (removed.length === 0) return { removed, clusters: [] };

    const clusters = this._detachUnsupported();
    this.colliderDirty = true;
    return { removed, clusters };
  }

  // ── Structural support ─────────────────────────────────────────────────

  /**
   * Solve the structure and detach everything that fails. Two independent failure modes,
   * both now driven by the material constants that ship in every volume:
   *
   *   TENSION / BENDING -- a load path is traced from the grounded voxels upward. Going
   *     straight up a column is free; every lateral or hanging step spends part of a
   *     budget, and the cost of a step is set by how far that material can actually
   *     cantilever (see cantileverVoxels). Run out of budget and the voxel has no way to
   *     reach the ground: it is severed and falls.
   *
   *   COMPRESSION -- weight is accumulated downward through the surviving voxels and
   *     divided by the voxel's face area to give a real stress in pascals. Exceed the
   *     material's compressive strength and it crushes. A 34 m stone keep loads its base
   *     to about 0.8 MPa against a 20 MPa limit, so it stands -- until you carve away
   *     enough of that base that the remaining columns carry twenty-five times the load,
   *     and then it does not.
   *
   * Crushing cascades across carves rather than within one: crushed voxels are removed
   * now, and whatever they were holding fails on the next solve. One pass per shot keeps
   * a carve bounded, and a real collapse takes a beat to run through a building anyway.
   */
  _detachUnsupported() {
    const [nx, ny, nz] = this.dims;
    const layer = nx * ny;
    const support = new Int16Array(this.cells.length).fill(-1);

    // Bucket queue, processed from strongest support down, so each voxel is finalized
    // the first time it is popped (Dijkstra over a small integer range).
    const buckets = Array.from({ length: SUPPORT_RESOLUTION + 1 }, () => []);
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const i = x + z * layer; // y = 0: sitting on the ground grounds a column —
        // but only while the ground is actually still there (undermining check).
        if (this.cells[i] !== 0 && this._groundIntact(x, z)) {
          support[i] = SUPPORT_RESOLUTION;
          buckets[SUPPORT_RESOLUTION].push(i);
        }
      }
    }

    for (let s = SUPPORT_RESOLUTION; s > 0; s--) {
      const bucket = buckets[s];
      for (let b = 0; b < bucket.length; b++) {
        const i = bucket[b];
        if (support[i] !== s) continue; // superseded by a stronger path
        const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / layer) | 0;
        // Up a column costs nothing: that is pure compression, and masonry is strong in
        // compression. Every sideways or hanging step is bending, and pays.
        this._relax(support, buckets, x, y + 1, z, s, 0);
        this._relax(support, buckets, x + 1, y, z, s, 1);
        this._relax(support, buckets, x - 1, y, z, s, 1);
        this._relax(support, buckets, x, y, z + 1, s, 1);
        this._relax(support, buckets, x, y, z - 1, s, 1);
        this._relax(support, buckets, x, y - 1, z, s, 1);   // hanging below
      }
      bucket.length = 0;
    }

    // Failing voxels → connected clusters (6-conn flood fill), removed from the grid.
    const clusters = [];
    const failing = [];
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] !== 0 && support[i] <= 0) failing.push(i);
    }
    // Compression pass over everything the load path DID reach.
    const area = this.scale * this.scale;
    const load = new Float32Array(this.cells.length);
    for (let y = ny - 1; y >= 0; y--) {
      for (let z = 0; z < nz; z++) {
        const rowBase = y * nx + z * layer;
        for (let x = 0; x < nx; x++) {
          const i = rowBase + x;
          const v = this.cells[i];
          if (v === 0 || support[i] <= 0) continue;
          const carried = load[i] + this.voxelWeight[v];
          if (carried / area > this.crushStress[v]) { failing.push(i); continue; }
          if (y === 0) continue;
          const below = i - nx;
          if (this.cells[below] !== 0) { load[below] += carried; continue; }
          // Nothing directly underneath: the load spreads onto whatever diagonal
          // neighbours below are solid, the way a corbelled course sheds weight sideways.
          let n = 0;
          const cand = [];
          if (x > 0 && this.cells[below - 1] !== 0) { cand.push(below - 1); n++; }
          if (x < nx - 1 && this.cells[below + 1] !== 0) { cand.push(below + 1); n++; }
          if (z > 0 && this.cells[below - layer] !== 0) { cand.push(below - layer); n++; }
          if (z < nz - 1 && this.cells[below + layer] !== 0) { cand.push(below + layer); n++; }
          if (n === 0) continue; // hanging; the tension pass already judged it
          const share = carried / n;
          for (const c of cand) load[c] += share;
        }
      }
    }
    if (failing.length === 0) return clusters;

    const failSet = new Uint8Array(this.cells.length);
    for (const i of failing) failSet[i] = 1;

    for (const seed of failing) {
      if (failSet[seed] !== 1) continue;
      const voxels = [];
      const stack = [seed];
      failSet[seed] = 2;
      while (stack.length > 0) {
        const i = stack.pop();
        const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / layer) | 0;
        voxels.push({ x, y, z, value: this.cells[i] });
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const qx = x + dx, qy = y + dy, qz = z + dz;
          if (qx < 0 || qy < 0 || qz < 0 || qx >= nx || qy >= ny || qz >= nz) continue;
          const q = qx + qy * nx + qz * layer;
          if (failSet[q] === 1) { failSet[q] = 2; stack.push(q); }
        }
      }
      for (const v of voxels) {
        this.cells[v.x + v.y * nx + v.z * layer] = 0;
        this.solidCount--;
        this._markDirty(v.x, v.y, v.z);
      }
      for (const part of this._fracture(voxels)) clusters.push({ voxels: part });
    }
    return clusters;
  }

  /**
   * Split one detached blob along fracture planes. Masonry does not come away as a single
   * smooth lump: it breaks into angular, interlocking pieces. A Voronoi partition around
   * random seed points inside the blob is the cheapest thing that produces exactly that —
   * flat internal faces, irregular sizes, no rounding.
   *
   * Small blobs are left whole: below FRACTURE_MIN_VOXELS the debris system bursts them
   * to particles anyway, so splitting would only add bookkeeping.
   */
  _fracture(voxels) {
    if (voxels.length < FRACTURE_MIN_VOXELS) return [voxels];
    const k = Math.min(FRACTURE_MAX_PIECES,
      Math.max(2, Math.round(voxels.length / FRACTURE_VOXELS_PER_PIECE)));
    const seeds = [];
    for (let i = 0; i < k; i++) seeds.push(voxels[(Math.random() * voxels.length) | 0]);

    const groups = Array.from({ length: k }, () => []);
    for (const v of voxels) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < k; i++) {
        const s = seeds[i];
        const dx = v.x - s.x, dy = v.y - s.y, dz = v.z - s.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      groups[best].push(v);
    }
    return groups.filter(g => g.length > 0);
  }

  /**
   * Does `world` sit inside this building with solid voxels overhead? Used by the audio
   * reverb zones to decide whether the player is in a stone room or in the open.
   * Returns 0 (outside) or 1 (enclosed) rather than a boolean so callers can max() over
   * every structure and feed the result straight into a crossfade.
   *
   * The ceiling scan is capped: a full column walk on a 112-tall refined castle, run for
   * every structure every frame, is exactly the kind of loop that turns a 4 Hz check into
   * a per-frame cost. 40 cells above the head is the tallest ceiling worth detecting.
   */
  indoorAt(world) {
    const local = this._indoorVec ??= new THREE.Vector3();
    local.copy(world).applyMatrix4(this.inverseMatrix);
    const [nx, ny, nz] = this.dims;
    const x = Math.floor(local.x + this.cx);
    const y = Math.floor(local.y);
    const z = Math.floor(local.z + this.cz);
    if (x < 0 || z < 0 || x >= nx || z >= nz || y < 0 || y >= ny) return 0;
    if (this.cells[x + y * nx + z * nx * ny] !== 0) return 0; // standing in solid rock
    const layer = nx * ny;
    const top = Math.min(ny - 1, y + 40);
    for (let yy = y + 1; yy <= top; yy++) {
      if (this.cells[x + yy * nx + z * layer] !== 0) return 1;
    }
    return 0;
  }

  /**
   * Is the terrain under base voxel (x, 0, z) still at pad height? The build pad was
   * flattened to the structure's base at spawn, so any surface more than ~one voxel
   * below the base means someone dug it out — that column no longer grounds anything.
   */
  _groundIntact(x, z) {
    if (!this.terrain) return true;
    const w = this._groundProbe ??= new THREE.Vector3();
    w.set(x + 0.5 - this.cx, 0.5, z + 0.5 - this.cz).applyMatrix4(this.group.matrixWorld);
    return this.terrain.heightAt(w.x, w.z) >= this.group.position.y - this.scale * 1.2;
  }

  /**
   * Re-run the support solve without a carve — call after the terrain near this
   * structure was dug (undermining). Returns detached clusters exactly like
   * carveSphere's second half; the caller turns them into debris.
   */
  recheckSupport() {
    if (this.solidCount === 0) return [];
    const clusters = this._detachUnsupported();
    if (clusters.length > 0) this.colliderDirty = true;
    return clusters;
  }

  /**
   * Relax the load path into a neighbour. `steps` is 0 for straight up (free) and 1 for a
   * bending step, whose cost in budget comes from the DESTINATION material -- oak spends
   * one unit and reaches sixty-four steps, plaster spends five and reaches twelve.
   */
  _relax(support, buckets, x, y, z, s, steps) {
    const [nx, ny, nz] = this.dims;
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
    const i = x + y * nx + z * nx * ny;
    const v = this.cells[i];
    if (v === 0) return;
    const next = steps === 0 ? s : s - this.stepCost[v];
    if (next <= 0 || support[i] >= next) return;
    support[i] = next;
    buckets[next].push(i);
  }

  // ── Raycast (Amanatides-Woo DDA in voxel space) ───────────────────────

  /** @returns {{ distance:number, point:THREE.Vector3 } | null} nearest solid-voxel hit */
  raycast(origin, direction, maxDistance) {
    const o = origin.clone().applyMatrix4(this.inverseMatrix);
    o.x += this.cx; o.z += this.cz;
    const d = direction.clone().transformDirection(this.inverseMatrix).normalize();

    const [nx, ny, nz] = this.dims;
    const maxT = maxDistance / this.scale;

    // Clip the ray to the grid AABB BEFORE marching, and start the DDA at the entry
    // point. This is not an optimisation, it is a correctness fix: the march advances one
    // CELL per iteration and is bounded by a guard proportional to the grid size, so a
    // ray that starts far outside spends its whole budget crossing empty space and
    // returns null before it ever reaches the wall. At 0.25-unit voxels and a 160-unit
    // weapon range that is 640 cells of approach against a guard of a few hundred — which
    // is exactly why small or distant structures could not be shot at all, while the big
    // ones (bigger grid, bigger guard) worked fine.
    let tEnter = 0, tExit = maxT, enterAxis = -1;
    const oc = [o.x, o.y, o.z], dc = [d.x, d.y, d.z], hi = [nx, ny, nz];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dc[a]) < 1e-9) {
        if (oc[a] < 0 || oc[a] > hi[a]) return null;   // parallel and outside the slab
        continue;
      }
      const inv = 1 / dc[a];
      let ta = (0 - oc[a]) * inv;
      let tb = (hi[a] - oc[a]) * inv;
      if (ta > tb) { const swap = ta; ta = tb; tb = swap; }
      if (ta > tEnter) { tEnter = ta; enterAxis = a; }
      if (tb < tExit) tExit = tb;
      if (tEnter > tExit) return null;
    }

    let t = tEnter;
    // Nudge inside the entry face so floor() cannot land on the cell behind it.
    const ex = o.x + d.x * (t + 1e-4);
    const ey = o.y + d.y * (t + 1e-4);
    const ez = o.z + d.z * (t + 1e-4);
    let x = Math.min(nx - 1, Math.max(0, Math.floor(ex)));
    let y = Math.min(ny - 1, Math.max(0, Math.floor(ey)));
    let z = Math.min(nz - 1, Math.max(0, Math.floor(ez)));

    const stepX = Math.sign(d.x) || 1, stepY = Math.sign(d.y) || 1, stepZ = Math.sign(d.z) || 1;
    const tDeltaX = Math.abs(1 / d.x), tDeltaY = Math.abs(1 / d.y), tDeltaZ = Math.abs(1 / d.z);
    let tMaxX = d.x !== 0 ? t + ((stepX > 0 ? x + 1 - ex : ex - x) * tDeltaX) : Infinity;
    let tMaxY = d.y !== 0 ? t + ((stepY > 0 ? y + 1 - ey : ey - y) * tDeltaY) : Infinity;
    let tMaxZ = d.z !== 0 ? t + ((stepZ > 0 ? z + 1 - ez : ez - z) * tDeltaZ) : Infinity;

    // Face the ray last crossed, kept current so the hit can report a normal — decals and
    // impact sprays need one, and the caller previously got `undefined`. Seeded from the
    // slab test's entry axis; when the origin is already inside the grid there is no
    // entry face, so fall back to the axis the ray travels most slowly along.
    let axis = enterAxis >= 0 ? enterAxis : 1;
    let axisStep = axis === 0 ? stepX : axis === 1 ? stepY : stepZ;

    // One iteration per cell crossed, and the ray can cross at most the grid's Manhattan
    // span before it exits — hence this bound rather than a multiple of it.
    const guard = nx + ny + nz + 3;
    for (let i = 0; i < guard; i++) {
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return null;
      if (this.at(x, y, z) !== 0) {
        const localPoint = new THREE.Vector3(
          o.x + d.x * t - this.cx, o.y + d.y * t, o.z + d.z * t - this.cz);
        const localNormal = new THREE.Vector3(
          axis === 0 ? -axisStep : 0, axis === 1 ? -axisStep : 0, axis === 2 ? -axisStep : 0);
        return {
          distance: t * this.scale,
          point: localPoint.applyMatrix4(this.group.matrixWorld),
          normal: localNormal.transformDirection(this.group.matrixWorld).normalize(),
        };
      }
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        t = tMaxX; tMaxX += tDeltaX; x += stepX; axis = 0; axisStep = stepX;
      } else if (tMaxY <= tMaxZ) {
        t = tMaxY; tMaxY += tDeltaY; y += stepY; axis = 1; axisStep = stepY;
      } else {
        t = tMaxZ; tMaxZ += tDeltaZ; z += stepZ; axis = 2; axisStep = stepZ;
      }
      if (t > tExit || t > maxT) return null;
    }
    return null;
  }

  // ── Render meshes (chunked, rebuilt only where carved) ─────────────────

  _markDirty(x, y, z) {
    // Derived from CHUNK, NOT hardcoded. These were `>> 4` / `& 15` while CHUNK is 32, so
    // every carve marked the WRONG chunk dirty: the chunk that actually changed never
    // re-meshed and an unrelated one did. The hole existed in the grid and in the
    // collider, but not on screen.
    const cxk = Math.floor(x / CHUNK), cyk = Math.floor(y / CHUNK), czk = Math.floor(z / CHUNK);
    const mark = (a, b, c) => {
      const key = `${a},${b},${c}`;
      this.dirtyChunks.add(key);
      this.colliderDirtyChunks.add(key);
    };
    mark(cxk, cyk, czk);
    // A face on a chunk border changes the neighbour chunk's visible faces too.
    const lx = x % CHUNK, ly = y % CHUNK, lz = z % CHUNK;
    if (lx === 0) mark(cxk - 1, cyk, czk);
    if (lx === CHUNK - 1) mark(cxk + 1, cyk, czk);
    if (ly === 0) mark(cxk, cyk - 1, czk);
    if (ly === CHUNK - 1) mark(cxk, cyk + 1, czk);
    if (lz === 0) mark(cxk, cyk, czk - 1);
    if (lz === CHUNK - 1) mark(cxk, cyk, czk + 1);
    this.colliderDirty = true;
  }

  *_allChunkKeys() {
    const [nx, ny, nz] = this.dims;
    for (let z = 0; z < Math.ceil(nz / CHUNK); z++)
      for (let y = 0; y < Math.ceil(ny / CHUNK); y++)
        for (let x = 0; x < Math.ceil(nx / CHUNK); x++)
          yield `${x},${y},${z}`;
  }

  rebuildDirtyChunks() {
    for (const key of this.dirtyChunks) {
      const [ckx, cky, ckz] = key.split(',').map(Number);
      if (ckx < 0 || cky < 0 || ckz < 0) continue;
      const old = this.chunkMeshes.get(key);
      if (old) { this.group.remove(old); old.geometry.dispose(); this.chunkMeshes.delete(key); }

      const geometry = this._buildChunkGeometry(ckx * CHUNK, cky * CHUNK, ckz * CHUNK);
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.chunkMeshes.set(key, mesh);
    }
    this.dirtyChunks.clear();
  }

  _buildChunkGeometry(x0, y0, z0) {
    const [nx, ny, nz] = this.dims;
    const positions = [], normals = [], colors = [];
    for (let z = z0; z < Math.min(z0 + CHUNK, nz); z++) {
      for (let y = y0; y < Math.min(y0 + CHUNK, ny); y++) {
        for (let x = x0; x < Math.min(x0 + CHUNK, nx); x++) {
          const value = this.at(x, y, z);
          if (value === 0) continue;
          const p = (value - 1) * 4;
          const r = this.palette[p] / 255, g = this.palette[p + 1] / 255, b = this.palette[p + 2] / 255;
          for (const face of FACES) {
            if (this.at(x + face.d[0], y + face.d[1], z + face.d[2]) !== 0) continue;
            for (const i of [0, 1, 2, 0, 2, 3]) {
              positions.push(x + face.c[i][0] - this.cx, y + face.c[i][1], z + face.c[i][2] - this.cz);
              normals.push(face.n[0], face.n[1], face.n[2]);
              colors.push(r, g, b);
            }
          }
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

  // ── Static collision (exact, greedy-merged, one body per chunk) ────────

  /**
   * Rebuild collision for the chunks a carve touched. Each chunk becomes one static body
   * whose shapes are its greedy-merged solid voxels, so the collider is the shape you can
   * see instead of a lattice drawn around it.
   */
  rebuildCollider() {
    if (!this.colliderDirty) return;
    this.colliderDirty = false;
    if (this.colliderDirtyChunks.size === 0) return;

    const [nx, ny, nz] = this.dims;
    const cx = Math.ceil(nx / CHUNK), cy = Math.ceil(ny / CHUNK), cz = Math.ceil(nz / CHUNK);
    const px = this.group.position, ry = this.group.rotation.y;

    for (const key of this.colliderDirtyChunks) {
      const [ci, cj, ck] = key.split(',').map(Number);
      const old = this.colliderBodies.get(key);
      if (old) { this.physicsWorld.removeBody(old); this.colliderBodies.delete(key); }
      if (ci < 0 || cj < 0 || ck < 0 || ci >= cx || cj >= cy || ck >= cz) continue;

      const x0 = ci * CHUNK, y0 = cj * CHUNK, z0 = ck * CHUNK;
      const w = Math.min(CHUNK, nx - x0), h = Math.min(CHUNK, ny - y0), d = Math.min(CHUNK, nz - z0);
      const sub = new Uint8Array(w * h * d);
      let any = false;
      for (let z = 0; z < d; z++) {
        for (let y = 0; y < h; y++) {
          const src = x0 + (y0 + y) * nx + (z0 + z) * nx * ny;
          const dst = y * w + z * w * h;
          for (let x = 0; x < w; x++) {
            if (this.cells[src + x] !== 0) { sub[dst + x] = 1; any = true; }
          }
        }
      }
      if (!any) continue;

      const { boxes, count } = greedyBoxes(sub, [w, h, d], COLLIDER_BOX_BUDGET);
      const body = new CANNON.Body({ type: CANNON.Body.STATIC, material: this.physicsMaterial });
      for (let i = 0; i < count; i++) {
        const o = i * 6;
        body.addShape(
          new CANNON.Box(new CANNON.Vec3(
            boxes[o + 3] * this.scale, boxes[o + 4] * this.scale, boxes[o + 5] * this.scale)),
          new CANNON.Vec3(
            (x0 + boxes[o] - this.cx) * this.scale,
            (y0 + boxes[o + 1]) * this.scale,
            (z0 + boxes[o + 2] - this.cz) * this.scale));
      }
      body.position.set(px.x, px.y, px.z);
      body.quaternion.setFromEuler(0, ry, 0);
      this.physicsWorld.addBody(body);
      this.colliderBodies.set(key, body);
    }
    this.colliderDirtyChunks.clear();
  }


  /** Is the voxel containing this world-space point solid? (enemy steering probes) */
  solidAtWorld(point) {
    const local = point.clone().applyMatrix4(this.inverseMatrix);
    return this.at(Math.floor(local.x + this.cx), Math.floor(local.y), Math.floor(local.z + this.cz)) !== 0;
  }

  /** World-space center of one voxel — where a detached cluster's debris spawns. */
  voxelWorldCenter(x, y, z) {
    return new THREE.Vector3(x + 0.5 - this.cx, y + 0.5, z + 0.5 - this.cz)
      .applyMatrix4(this.group.matrixWorld);
  }

  dispose() {
    for (const mesh of this.chunkMeshes.values()) { this.group.remove(mesh); mesh.geometry.dispose(); }
    this.chunkMeshes.clear();
    this.material.dispose();
    this.scene.remove(this.group);
    // Per-chunk collider bodies, not the single `this.body` that used to exist. Removing
    // a property that is now always undefined silently leaked every one of them.
    for (const body of this.colliderBodies.values()) this.physicsWorld.removeBody(body);
    this.colliderBodies.clear();
  }
}
