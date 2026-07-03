// enemy.js — VoxelEnemy (extracted from the original voxelshooter.js monolith).
// Per AGENT.MD: split Voxel Shooter across multiple files, never one mega-file.
// Each enemy is a 7×7×7 InstancedMesh — every shot "carves" voxels, so players
// see the cube degrade under sustained fire.

import * as THREE from 'three';

const GRID = 7;          // 7×7×7 voxels per enemy
const VSIZ = 0.5;        // voxel edge length (world units)
const HALF = (GRID * VSIZ) / 2;

// Shared geometry + helpers (one allocation, reused across all enemies).
const _sharedGeo = new THREE.BoxGeometry(VSIZ, VSIZ, VSIZ);
const _dummy = new THREE.Object3D();
const _col   = new THREE.Color();

// Eight accent palettes — kept saturated so the result reads as "voxel art"
// rather than realistic stone. Each instance gets a ±15% jitter so two cubes
// of the same palette still look handcrafted.
export const ENEMY_PALETTES = [
  0xF72585, 0x4CC9F0, 0x7209B7, 0xFF6B35,
  0x4ade80, 0xfbbf24, 0xef4444, 0x818cf8,
];

export class VoxelEnemy {
  /**
   * @param {THREE.Scene} scene
   * @param {number} x world X
   * @param {number} y world Y (usually ~0.5–2)
   * @param {number} z world Z
   * @param {number} [variant=0] palette variant (or RNG-driven)
   * @param {import('./rng.js').RngLike} [rng] optional seeded RNG
   */
  constructor(scene, x, y, z, variant = 0, rng) {
    const count = GRID * GRID * GRID;
    this.health    = count;
    this.maxHealth = count;

    const base = ENEMY_PALETTES[variant % ENEMY_PALETTES.length];
    const mat  = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.7 });

    this.mesh = new THREE.InstancedMesh(_sharedGeo, mat, count);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;

    // Local offsets per voxel. Stored on the enemy so applyDamage can mark
    // them dead without rebuilding the InstancedMesh.
    this._offsets = new Array(count);
    let idx = 0;
    for (let ix = 0; ix < GRID; ix++) {
      for (let iy = 0; iy < GRID; iy++) {
        for (let iz = 0; iz < GRID; iz++, idx++) {
          const lx = ix * VSIZ - HALF;
          const ly = iy * VSIZ;
          const lz = iz * VSIZ - HALF;
          this._offsets[idx] = { lx, ly, lz, alive: true };
          _dummy.position.set(lx, ly, lz);
          _dummy.scale.setScalar(1);
          _dummy.updateMatrix();
          this.mesh.setMatrixAt(idx, _dummy.matrix);
          _col.setHex(base);
          if (rng) {
            _col.r = Math.max(0, Math.min(1, _col.r + (rng.next() - .5) * .3));
            _col.g = Math.max(0, Math.min(1, _col.g + (rng.next() - .5) * .3));
            _col.b = Math.max(0, Math.min(1, _col.b + (rng.next() - .5) * .3));
          } else {
            _col.r = Math.max(0, Math.min(1, _col.r + (Math.random() - .5) * .3));
            _col.g = Math.max(0, Math.min(1, _col.g + (Math.random() - .5) * .3));
            _col.b = Math.max(0, Math.min(1, _col.b + (Math.random() - .5) * .3));
          }
          this.mesh.setColorAt(idx, _col);
        }
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    // Cheap movement proxy.
    this.group = new THREE.Object3D();
    this.group.position.set(x, y, z);
    this.group.add(this.mesh);
    scene.add(this.group);
  }

  /** Walk straight toward the player in the XZ plane. */
  moveToward(target, speed, dt) {
    const gp = this.group.position;
    const dx = target.x - gp.x;
    const dz = target.z - gp.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.1) return;
    gp.x += (dx / len) * speed * dt;
    gp.z += (dz / len) * speed * dt;
  }

  /**
   * Carve a sphere of voxels out of the cube around the local hit point.
   * Returns the number destroyed (used by the orchestrator for scoring).
   */
  applyDamage(worldHitPoint, blastRadius) {
    const local = this.group.worldToLocal(worldHitPoint.clone());
    const r2 = blastRadius * blastRadius;
    let destroyed = 0;
    for (let i = 0; i < this._offsets.length; i++) {
      const o = this._offsets[i];
      if (!o.alive) continue;
      const dx = o.lx - local.x;
      const dy = o.ly - local.y;
      const dz = o.lz - local.z;
      if (dx * dx + dy * dy + dz * dz <= r2) {
        o.alive = false;
        this.health--;
        destroyed++;
        _dummy.position.set(o.lx, o.ly, o.lz);
        _dummy.scale.setScalar(0);
        _dummy.updateMatrix();
        this.mesh.setMatrixAt(i, _dummy.matrix);
      }
    }
    if (destroyed > 0) this.mesh.instanceMatrix.needsUpdate = true;
    return destroyed;
  }

  /** Health remaining as a 0..1 fraction (used by the HUD bar). */
  healthPct() {
    return this.maxHealth > 0 ? this.health / this.maxHealth : 0;
  }

  dispose(scene) {
    scene.remove(this.group);
    this.mesh.dispose();
    this.mesh.material.dispose();
  }
}
