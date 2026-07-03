// terrain.js — Destructible voxel terrain (Feature #3).
// A sparse InstancedMesh of 1×1×1 voxel cells pre-placed around the player
// as cover. Bullets, when they miss an enemy, carve a sphere of cells out of
// the terrain — players can blast new sightlines mid-fight or hollow out a
// bunker to hide in. Player + enemy movement treat solid cells as obstacles.
//
// The terrain is intentionally sparse and 1 block tall so it stays
// mobile-friendly: the playfield stays readable, and InstancedMesh keeps
// us under one draw call no matter how many cells are alive.

import * as THREE from 'three';

const CELL = 1.0;          // world size of one voxel cell
const MAX_CELLS = 6000;    // pool size; we ship ~150–300 alive, this is just the ceiling

// Per-cell base colors — picked with a "cool fortified bunker" palette so the
// terrain reads as architecture, not as another enemy type.
const TERRAIN_COLORS = [0x4a5870, 0x3a4a60, 0x5a6a82, 0x6a7a94, 0x2a3a48, 0x55657d];

export class VoxelTerrain {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./rng.js').RngLike} rng
   */
  constructor(scene, rng) {
    this.scene = scene;
    this.rng = rng;
    this.cellSize = CELL;

    // Pool bookkeeping — free-list of unused instance slots, plus a set of
    // currently alive cells keyed by "x,y,z" for O(1) membership tests.
    this._free = [];
    this._indexOf = new Map();   // "x,y,z" -> instance index
    this._aliveCount = 0;

    const geo = new THREE.BoxGeometry(CELL, CELL, CELL);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_CELLS);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;

    // Hide every instance by zero-scaling — only cells we explicitly add()
    // ever become visible. The block below is one allocation upfront, never
    // touched again at runtime.
    const hide = new THREE.Matrix4().makeScale(0, 0, 0);
    const tmpColor = new THREE.Color();
    for (let i = MAX_CELLS - 1; i >= 0; i--) {
      this.mesh.setMatrixAt(i, hide);
      this._free.push(i);
    }
    scene.add(this.mesh);

    // AABB of the playfield. The terrain generator is confined so enemies
    // can't spawn inside a wall and bullets can't carve the edge of the map.
    this.playfieldRadius = 70;
  }

  /**
   * Generate the initial cover: half a dozen small "bunker" patches and a
   * ring of low walls at the cardinal directions. The exact layout varies
   * by RNG seed so daily seeds feel different.
   */
  generateInitialLayout() {
    const rng = this.rng;
    // Center staging mound — gives the player spawn a lip to duck behind.
    this._fillBox(-1, -1, -1, 1, 0, 1);

    // Four outlying "bunker" boxes spread on the cardinals, each 2×1×1.
    const cardinals = [[18, 18], [-18, 18], [18, -18], [-18, -18]];
    for (const [cx, cz] of cardinals) {
      this._fillBox(cx - 1, 0, cz - 1, cx + 1, 0, cz + 1);
    }
    // Eight short wall segments farther out so the field looks "lived in".
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 + rng.range(-0.1, 0.1);
      const r = rng.range(28, 42);
      const cx = Math.round(Math.cos(ang) * r);
      const cz = Math.round(Math.sin(ang) * r);
      const horiz = rng.next() < 0.5;
      const len = rng.int(2, 4);
      for (let k = -len; k <= len; k++) {
        if (horiz) this._addCell(cx, 0, cz + k);
        else        this._addCell(cx + k, 0, cz);
      }
    }
    // A smattering of single-cell obstacles around the playfield floor for
    // texture. Capped and sparse so the field stays navigable.
    for (let i = 0; i < 22; i++) {
      const x = rng.int(-40, 40);
      const z = rng.int(-40, 40);
      // Don't drop junk right on top of the cardinal bunkers.
      if (Math.abs(x) < 5 && Math.abs(z) < 5) continue;
      this._addCell(x, 0, z);
    }
  }

  /** Internal: stamp a filled 1-tall box from (x0,_,z0) to (x1,_,z1) inclusive. */
  _fillBox(x0, _, z0, x1, __, z1) {
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) this._addCell(x, 0, z);
  }

  /** Add (or skip) a single cell. Returns true if it was newly added. */
  _addCell(x, y, z) {
    if (Math.abs(x) > this.playfieldRadius || Math.abs(z) > this.playfieldRadius) return false;
    const key = `${x},${y},${z}`;
    if (this._indexOf.has(key)) return false;
    if (this._free.length === 0) return false;
    const idx = this._free.pop();
    this._indexOf.set(key, idx);
    this._aliveCount++;

    const m = new THREE.Matrix4();
    m.setPosition(x + 0.5, y + 0.5, z + 0.5);
    this.mesh.setMatrixAt(idx, m);

    const color = new THREE.Color(TERRAIN_COLORS[Math.floor(this.rng.next() * TERRAIN_COLORS.length)]);
    this.mesh.setColorAt(idx, color);

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return true;
  }

  /** Remove a single cell. */
  _removeCell(x, y, z) {
    const key = `${x},${y},${z}`;
    const idx = this._indexOf.get(key);
    if (idx === undefined) return false;
    const hide = new THREE.Matrix4().makeScale(0, 0, 0);
    this.mesh.setMatrixAt(idx, hide);
    this._free.push(idx);
    this._indexOf.delete(key);
    this._aliveCount--;
    this.mesh.instanceMatrix.needsUpdate = true;
    return true;
  }

  /**
   * Public: carve a sphere of terrain around a world-space hit point.
   * Returns the number of cells removed.
   */
  carve(worldPoint, radius = 1.6) {
    const cx = Math.floor(worldPoint.x);
    const cy = Math.floor(worldPoint.y);
    const cz = Math.floor(worldPoint.z);
    const r = Math.ceil(radius);
    const r2 = radius * radius;
    let removed = 0;
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++)
        for (let z = cz - r; z <= cz + r; z++) {
          const wx = x + 0.5, wy = y + 0.5, wz = z + 0.5;
          const dx = wx - worldPoint.x, dy = wy - worldPoint.y, dz = wz - worldPoint.z;
          if (dx * dx + dy * dy + dz * dz <= r2) {
            if (this._removeCell(x, y, z)) removed++;
          }
        }
    return removed;
  }

  /**
   * Raycast against the alive terrain cells. Returns the standard Three.js
   * intersect result (or null) — the bullet carve code uses .point.clone().
   */
  raycast(raycaster) {
    const hits = raycaster.intersectObject(this.mesh, false);
    return hits.length ? hits[0] : null;
  }

  /**
   * Treat solid cells as a moving obstacle: try `to` with sampling. Returns
   * the farthest reachable point in the XZ plane that doesn't pierce a cell.
   * Y is preserved from `from`.
   */
  clampMove(from, to, padding = 0.45) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 1e-4) return to.clone();
    // Step in 0.3-unit slices for stability near tight cover.
    const steps = Math.max(1, Math.ceil(dist / 0.3));
    const res = from.clone();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = from.x + dx * t;
      const pz = from.z + dz * t;
      if (this._impAt(px, pz, padding)) break;
      res.set(px, from.y, pz);
    }
    return res;
  }

  /** True if any cell within (padding + 0.5) world units of (x,z) at y=0.5 is alive. */
  _impAt(x, z, padding) {
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (!this._indexOf.has(`${fx + dx},0,${fz + dz}`)) continue;
        const cxw = fx + dx + 0.5;
        const czw = fz + dz + 0.5;
        if (Math.abs(cxw - x) < 0.5 + padding && Math.abs(czw - z) < 0.5 + padding) return true;
      }
    }
    return false;
  }

  /** Disposal: drop mesh and reset for a fresh game. */
  reset() {
    const hide = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const idx of this._indexOf.values()) this.mesh.setMatrixAt(idx, hide);
    this._free.length = 0;
    for (let i = MAX_CELLS - 1; i >= 0; i--) this._free.push(i);
    this._indexOf.clear();
    this._aliveCount = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Mesh + materials live for the lifetime of the page; no dispose needed. */
}
