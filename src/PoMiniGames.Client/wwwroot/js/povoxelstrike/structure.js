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

const CHUNK = 16;          // render-mesh rebuild granularity (voxels per chunk axis)
const COLLIDER_BLOCK = 4;  // static-collider granularity (voxels per box axis)

// Lateral steps a voxel can sit from a supported column before it fails. The material
// table carries real strength constants, but one calibrated capacity reads better than
// pretending f32 pascals mean something at 64-voxel scale; per-material capacity can
// key off materials[].tensile when assets ship more than one material.
const SUPPORT_CAPACITY = 8;

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
  constructor(volume, scale, position, rotationY, scene, physicsWorld, terrain = null) {
    this.terrain = terrain;
    this.dims = volume.dims;
    this.palette = volume.palette;
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

    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.chunkMeshes = new Map(); // chunkKey -> Mesh
    this.dirtyChunks = new Set();
    for (const key of this._allChunkKeys()) this.dirtyChunks.add(key);
    this.rebuildDirtyChunks();

    this.body = null;
    this.colliderDirty = true;
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
    const r2 = r * r;
    const [nx, ny, nz] = this.dims;
    const removed = [];

    for (let z = Math.max(0, Math.floor(vz - r)); z <= Math.min(nz - 1, Math.ceil(vz + r)); z++) {
      for (let y = Math.max(0, Math.floor(vy - r)); y <= Math.min(ny - 1, Math.ceil(vy + r)); y++) {
        for (let x = Math.max(0, Math.floor(vx - r)); x <= Math.min(nx - 1, Math.ceil(vx + r)); x++) {
          const dx = x + 0.5 - vx, dy = y + 0.5 - vy, dz = z + 0.5 - vz;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          const i = x + y * nx + z * nx * ny;
          if (this.cells[i] === 0) continue;
          removed.push({ x, y, z, value: this.cells[i] });
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

  /** Solve the support field and carve out every failing voxel as connected clusters. */
  _detachUnsupported() {
    const [nx, ny, nz] = this.dims;
    const layer = nx * ny;
    const support = new Int8Array(this.cells.length).fill(-1);

    // Bucket queue, processed from strongest support down, so each voxel is finalized
    // the first time it is popped (Dijkstra over a tiny integer range).
    const buckets = Array.from({ length: SUPPORT_CAPACITY + 1 }, () => []);
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const i = x + z * layer; // y = 0: sitting on the ground grounds a column —
        // but only while the ground is actually still there (undermining check).
        if (this.cells[i] !== 0 && this._groundIntact(x, z)) {
          support[i] = SUPPORT_CAPACITY;
          buckets[SUPPORT_CAPACITY].push(i);
        }
      }
    }

    for (let s = SUPPORT_CAPACITY; s > 0; s--) {
      const bucket = buckets[s];
      for (let b = 0; b < bucket.length; b++) {
        const i = bucket[b];
        if (support[i] !== s) continue; // superseded by a stronger path
        const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / layer) | 0;
        // Up: a column transfers full support. Lateral and hanging-below: one step of
        // cantilever each. (dy, cost) per direction:
        this._relax(support, buckets, x, y + 1, z, s);       // up, free
        this._relax(support, buckets, x + 1, y, z, s - 1);
        this._relax(support, buckets, x - 1, y, z, s - 1);
        this._relax(support, buckets, x, y, z + 1, s - 1);
        this._relax(support, buckets, x, y, z - 1, s - 1);
        this._relax(support, buckets, x, y - 1, z, s - 1);   // hanging
      }
      bucket.length = 0;
    }

    // Failing voxels → connected clusters (6-conn flood fill), removed from the grid.
    const clusters = [];
    const failing = [];
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] !== 0 && support[i] <= 0) failing.push(i);
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
      clusters.push({ voxels });
    }
    return clusters;
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

  _relax(support, buckets, x, y, z, s) {
    if (s <= 0) return;
    const [nx, ny, nz] = this.dims;
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
    const i = x + y * nx + z * nx * ny;
    if (this.cells[i] === 0 || support[i] >= s) return;
    support[i] = s;
    buckets[s].push(i);
  }

  // ── Raycast (Amanatides-Woo DDA in voxel space) ───────────────────────

  /** @returns {{ distance:number, point:THREE.Vector3 } | null} nearest solid-voxel hit */
  raycast(origin, direction, maxDistance) {
    const o = origin.clone().applyMatrix4(this.inverseMatrix);
    o.x += this.cx; o.z += this.cz;
    const d = direction.clone().transformDirection(this.inverseMatrix).normalize();

    const [nx, ny, nz] = this.dims;
    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
    const stepX = Math.sign(d.x) || 1, stepY = Math.sign(d.y) || 1, stepZ = Math.sign(d.z) || 1;
    const tDeltaX = Math.abs(1 / d.x), tDeltaY = Math.abs(1 / d.y), tDeltaZ = Math.abs(1 / d.z);
    let tMaxX = d.x !== 0 ? ((stepX > 0 ? x + 1 - o.x : o.x - x) * tDeltaX) : Infinity;
    let tMaxY = d.y !== 0 ? ((stepY > 0 ? y + 1 - o.y : o.y - y) * tDeltaY) : Infinity;
    let tMaxZ = d.z !== 0 ? ((stepZ > 0 ? z + 1 - o.z : o.z - z) * tDeltaZ) : Infinity;

    const maxT = maxDistance / this.scale;
    let t = 0;
    for (let guard = 0; guard < 3 * (nx + ny + nz); guard++) {
      if (x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && this.at(x, y, z) !== 0) {
        const localPoint = new THREE.Vector3(
          o.x + d.x * t - this.cx, o.y + d.y * t, o.z + d.z * t - this.cz);
        return { distance: t * this.scale, point: localPoint.applyMatrix4(this.group.matrixWorld) };
      }
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { t = tMaxX; tMaxX += tDeltaX; x += stepX; }
      else if (tMaxY <= tMaxZ) { t = tMaxY; tMaxY += tDeltaY; y += stepY; }
      else { t = tMaxZ; tMaxZ += tDeltaZ; z += stepZ; }
      if (t > maxT) return null;
      // Left the grid moving away on every axis? The guard bound ends it regardless.
    }
    return null;
  }

  // ── Render meshes (chunked, rebuilt only where carved) ─────────────────

  _markDirty(x, y, z) {
    const cxk = x >> 4, cyk = y >> 4, czk = z >> 4; // CHUNK = 16
    this.dirtyChunks.add(`${cxk},${cyk},${czk}`);
    // A face on a chunk border changes the neighbour chunk's visible faces too.
    if ((x & 15) === 0) this.dirtyChunks.add(`${cxk - 1},${cyk},${czk}`);
    if ((x & 15) === 15) this.dirtyChunks.add(`${cxk + 1},${cyk},${czk}`);
    if ((y & 15) === 0) this.dirtyChunks.add(`${cxk},${cyk - 1},${czk}`);
    if ((y & 15) === 15) this.dirtyChunks.add(`${cxk},${cyk + 1},${czk}`);
    if ((z & 15) === 0) this.dirtyChunks.add(`${cxk},${cyk},${czk - 1}`);
    if ((z & 15) === 15) this.dirtyChunks.add(`${cxk},${cyk},${czk + 1}`);
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

  // ── Static collision (coarse compound of COLLIDER_BLOCK³ boxes) ────────

  rebuildCollider() {
    if (!this.colliderDirty) return;
    this.colliderDirty = false;
    if (this.body) { this.physicsWorld.removeBody(this.body); this.body = null; }
    if (this.solidCount === 0) return;

    const [nx, ny, nz] = this.dims;
    const body = new CANNON.Body({ type: CANNON.Body.STATIC });
    const half = (COLLIDER_BLOCK / 2) * this.scale;
    const shape = new CANNON.Box(new CANNON.Vec3(half, half, half));

    for (let bz = 0; bz < Math.ceil(nz / COLLIDER_BLOCK); bz++) {
      for (let by = 0; by < Math.ceil(ny / COLLIDER_BLOCK); by++) {
        for (let bx = 0; bx < Math.ceil(nx / COLLIDER_BLOCK); bx++) {
          if (!this._blockHasSolid(bx, by, bz)) continue;
          body.addShape(shape, new CANNON.Vec3(
            (bx * COLLIDER_BLOCK + COLLIDER_BLOCK / 2 - this.cx) * this.scale,
            (by * COLLIDER_BLOCK + COLLIDER_BLOCK / 2) * this.scale,
            (bz * COLLIDER_BLOCK + COLLIDER_BLOCK / 2 - this.cz) * this.scale));
        }
      }
    }
    body.position.set(this.group.position.x, this.group.position.y, this.group.position.z);
    body.quaternion.setFromEuler(0, this.group.rotation.y, 0);
    this.physicsWorld.addBody(body);
    this.body = body;
  }

  _blockHasSolid(bx, by, bz) {
    const [nx, ny, nz] = this.dims;
    for (let z = bz * COLLIDER_BLOCK; z < Math.min((bz + 1) * COLLIDER_BLOCK, nz); z++)
      for (let y = by * COLLIDER_BLOCK; y < Math.min((by + 1) * COLLIDER_BLOCK, ny); y++)
        for (let x = bx * COLLIDER_BLOCK; x < Math.min((bx + 1) * COLLIDER_BLOCK, nx); x++)
          if (this.cells[x + y * nx + z * nx * ny] !== 0) return true;
    return false;
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
    if (this.body) this.physicsWorld.removeBody(this.body);
  }
}
