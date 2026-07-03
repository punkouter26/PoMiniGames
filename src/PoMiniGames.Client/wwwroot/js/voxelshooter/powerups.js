// powerups.js — Power-up pickups (Feature #1).
// Dropped by defeated enemies. The player walks over them to activate a
// timed buff (rapid fire, spread shot, shield, health) or an instant effect
// (nuke — kill all visible enemies + bonus score).
//
// Each pickup is a rotating voxel cube with a colored point-light so the
// type is readable at a distance. Halo opacity + vertical bob communicate
// "freshness"; older pickups dim slightly so the eye picks out new ones.

import * as THREE from 'three';

// ── Power-up types ──────────────────────────────────────────────────────
// `duration` is in seconds. duration = 0 means "fire and forget" (instant).
// `apply(player, game)` returns the side-effect description for the HUD log.
export const POWERUP_TYPES = {
  RAPID_FIRE: {
    id: 'rapid_fire',
    label: 'RAPID FIRE',
    icon: '⚡',
    color: 0xfbbf24,
    duration: 6.0,
    onPick: '⚡ Rapid Fire x6s',
  },
  SPREAD: {
    id: 'spread',
    label: 'SPREAD',
    icon: '✦',
    color: 0x4ade80,
    duration: 8.0,
    onPick: '✦ Spread Shot x8s',
  },
  SHIELD: {
    id: 'shield',
    label: 'SHIELD',
    icon: '🛡',
    color: 0x00D9FF,
    duration: 12.0,
    onPick: '🛡 Shield x12s',
  },
  NUKE: {
    id: 'nuke',
    label: 'NUKE',
    icon: '☢',
    color: 0xFF3366,
    duration: 0,
    onPick: '☢ NUKE',
  },
  HEALTH: {
    id: 'health',
    label: 'HEALTH',
    icon: '❤',
    color: 0xff6b9d,
    duration: 0,
    onPick: '❤ Health +1',
  },
};

/** Pick a random type, weighted toward power-ups rather than instant heals. */
export function rollType(rng) {
  const order = [
    POWERUP_TYPES.RAPID_FIRE,
    POWERUP_TYPES.RAPID_FIRE,
    POWERUP_TYPES.SPREAD,
    POWERUP_TYPES.SPREAD,
    POWERUP_TYPES.SHIELD,
    POWERUP_TYPES.HEALTH,
    POWERUP_TYPES.NUKE,
  ];
  return order[Math.floor(rng.next() * order.length)];
}

let _idCounter = 1;

export class PowerUp {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./enemy.js').THREE_Vector3Compat} pos
   * @param {*} type one of POWERUP_TYPES
   */
  constructor(scene, pos, type) {
    this.scene = scene;
    this.type = type;
    this.id = _idCounter++;
    this.alive = true;
    this.tBorn = performance.now() / 1000;
    this.tLifetime = 22;        // pickups auto-vanish after this many seconds

    const geo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    const mat = new THREE.MeshStandardMaterial({
      color: type.color,
      emissive: type.color,
      emissiveIntensity: 0.6,
      roughness: 0.2,
      metalness: 0.4,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(pos.x, pos.y, pos.z);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // A faint translucent halo so the eye locks onto the pickup at distance.
    const haloGeo = new THREE.SphereGeometry(0.95, 14, 14);
    const haloMat = new THREE.MeshBasicMaterial({
      color: type.color, transparent: true, opacity: 0.22, depthWrite: false,
    });
    this.halo = new THREE.Mesh(haloGeo, haloMat);
    this.mesh.add(this.halo);

    // A short-range point light that makes the cell around the pickup glow.
    this.light = new THREE.PointLight(type.color, 1.4, 7, 2);
    this.light.position.set(0, 0, 0);
    this.mesh.add(this.light);
  }

  /**
   * @param {number} dt seconds
   * @returns {boolean} true while still alive; false once it should be removed
   */
  tick(dt) {
    const t = performance.now() / 1000;
    const age = t - this.tBorn;
    if (age > this.tLifetime) return false;
    this.mesh.rotation.y += dt * 3.0;
    this.mesh.rotation.x += dt * 1.5;
    this.mesh.position.y = 1.4 + Math.sin(age * 3.2) * 0.32;
    const scale = 1 + Math.sin(age * 4.0) * 0.18;
    this.halo.scale.setScalar(scale);
    // Slow desaturation in the last 4 s so the player notices it's expiring.
    const remaining = this.tLifetime - age;
    this.light.intensity = remaining < 4 ? Math.max(0.3, remaining / 4) : 1.4;
    return true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.halo.geometry.dispose();
    this.halo.material.dispose();
  }
}
