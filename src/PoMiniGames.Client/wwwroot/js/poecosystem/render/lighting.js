// lighting.js — sun, sky and the day/night cycle (SPEC §8: 120 s per cycle). The shadow
// camera follows the player, so a 2048 map covers the ~80 m the god can actually see
// rather than the whole 200 m island (the trick from povoxelstrike/game.js).
import * as THREE from 'three';

const SHADOW_HALF = 45;

const DAY_SKY = new THREE.Color(0x8ec5ff);
const NIGHT_SKY = new THREE.Color(0x0b1220);
const DUSK_SKY = new THREE.Color(0xf59e0b);
const DAY_SUN = new THREE.Color(0xfff2df);
const NIGHT_SUN = new THREE.Color(0x9db4d8);

export function createLighting(scene, { shadows = true, shadowMapSize = 2048 } = {}) {
  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2f3a2a, 1.1);
  const ambient = new THREE.AmbientLight(0xc8d4e8, 0.35);
  const sun = new THREE.DirectionalLight(0xfff2df, 2.0);
  sun.castShadow = shadows;
  if (shadows) {
    sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    sun.shadow.camera.left = -SHADOW_HALF; sun.shadow.camera.right = SHADOW_HALF;
    sun.shadow.camera.top = SHADOW_HALF; sun.shadow.camera.bottom = -SHADOW_HALF;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 260;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.5;
  }
  scene.add(hemi, ambient, sun, sun.target);

  const sky = new THREE.Color();
  const sunColour = new THREE.Color();

  return {
    sun, hemi, ambient,
    /** dayFraction 0..1 (0 = midnight). Returns the sky colour for the renderer's clear. */
    update(dayFraction, player) {
      const angle = (dayFraction - 0.25) * Math.PI * 2;      // 0.25 = sunrise
      const elevation = Math.sin(angle);
      const dist = 120;
      sun.position.set(player.x + Math.cos(angle) * dist, Math.max(4, elevation * dist), player.z + 60);
      sun.target.position.set(player.x, 0, player.z);
      sun.target.updateMatrixWorld();

      const day = Math.max(0, elevation);
      const dusk = Math.max(0, 1 - Math.abs(elevation) * 4);  // brief warm band at the horizon
      sky.copy(NIGHT_SKY).lerp(DAY_SKY, day).lerp(DUSK_SKY, dusk * 0.5);
      sunColour.copy(NIGHT_SUN).lerp(DAY_SUN, day);
      sun.color.copy(sunColour);
      sun.intensity = 0.15 + day * 2.0;
      hemi.intensity = 0.25 + day * 0.9;
      ambient.intensity = 0.18 + day * 0.25;
      return sky;
    },
    dispose() { scene.remove(hemi, ambient, sun, sun.target); sun.dispose?.(); },
  };
}
