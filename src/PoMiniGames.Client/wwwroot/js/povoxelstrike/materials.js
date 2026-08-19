// materials.js — the one place PoVoxelStrike decides what a surface is made of.
//
// The game shipped on MeshLambertMaterial: fast, but it has no roughness, no specular and
// no environment response, so stone, slate and terracotta all read as the same matte
// paint at different hues. The PBR path swaps in MeshStandardMaterial and lights it with
// an environment probe built from the live sky, which is what makes wet slate look
// different from dry plaster without authoring a single texture.
//
// Every module asks for its material HERE rather than constructing one inline, so the
// Lambert⇄Standard switch is a tier flag instead of a grep across six files. The Lambert
// path is kept (not deleted) because it is the low-tier fallback and the honest answer
// for a machine that cannot afford Standard across 2.2 M triangles.
//
// The probe is a 64×32 equirectangular gradient — sky above, ground bounce below, sun
// disc where the sun is — pushed through PMREMGenerator and assigned to scene.environment.
// MeshStandardMaterial picks scene.environment up on its own, so nothing has to be
// re-assigned when the sky changes; only the probe texture is rebuilt.

import * as THREE from 'three';

// Module-scoped tier. Terrain and Structure are constructed deep inside world.js, which
// has no reason to know about GFX settings, so the tier is published here once by
// game.start() instead of being threaded through four constructors that would only pass
// it along. Defaults to the Lambert path so an unset tier can never crash a material.
let activeQuality = { pbr: false, envMap: false };

/** Publish the resolved tier. Call once, before any world geometry is built. */
export function setQuality(quality) { activeQuality = quality; }

const PROBE_W = 64;
const PROBE_H = 32;
// Rebuilding a PMREM costs a handful of small blits. At a 360 s day cycle the sky moves
// far too slowly to justify doing it per frame, and far too fast to do it once.
const PROBE_INTERVAL_S = 2.5;

/**
 * Surface material for voxel geometry (terrain, structures, debris) — vertex-coloured,
 * since every voxel's colour comes from the palette baked into the mesh.
 */
export function createVoxelMaterial(extra = {}, quality = activeQuality) {
  if (!quality.pbr) return new THREE.MeshLambertMaterial({ vertexColors: true, ...extra });
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,   // stone and dirt; the env probe supplies the only sheen
    metalness: 0.02,   // not zero — a hair of grazing reflection keeps edges readable
    ...extra,
  });
}

/** Solid-colour material for actors (player capsule, enemies). */
export function createActorMaterial(params = {}, quality = activeQuality) {
  if (!quality.pbr) return new THREE.MeshLambertMaterial(params);
  return new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1, ...params });
}

/**
 * Image-based lighting from the current sky. Owns one PMREM texture and swaps it in
 * place on scene.environment; the previous one is disposed on every rebuild, because a
 * 360 s day at 2.5 s per rebuild would otherwise leak 144 cube render targets per day.
 */
export class SkyEnvironment {
  constructor(renderer, scene, quality) {
    this.scene = scene;
    this.enabled = !!quality.envMap && !!quality.pbr;
    this._clock = 0;
    this._texture = null;
    if (!this.enabled) return;

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.data = new Float32Array(PROBE_W * PROBE_H * 4);
    this.source = new THREE.DataTexture(this.data, PROBE_W, PROBE_H, THREE.RGBAFormat, THREE.FloatType);
    this.source.mapping = THREE.EquirectangularReflectionMapping;
    this.source.colorSpace = THREE.LinearSRGBColorSpace;
    this._sky = new THREE.Color();
    this._ground = new THREE.Color();
  }

  /**
   * @param key the sky key from Vfx (`{ top, horizon, sun, sunI }`)
   * @param sunDir THREE.Vector3 unit direction to the sun
   * @param force rebuild now, ignoring the interval (use on the first frame)
   */
  update(dt, key, sunDir, force = false) {
    if (!this.enabled || !key) return;
    this._clock -= dt;
    if (!force && this._clock > 0) return;
    this._clock = PROBE_INTERVAL_S;
    this._paint(key, sunDir);

    const next = this.pmrem.fromEquirectangular(this.source).texture;
    this._texture?.dispose();
    this._texture = next;
    this.scene.environment = next;
  }

  _paint(key, sunDir) {
    const d = this.data;
    for (let j = 0; j < PROBE_H; j++) {
      // v = 0 is the top of an equirect map, so elevation runs +1 (zenith) → −1 (nadir).
      const elev = 1 - (j + 0.5) / PROBE_H * 2;
      const up = Math.max(0, elev);
      if (elev >= 0) {
        this._sky.copy(key.horizon).lerp(key.top, Math.pow(up, 0.55));
      } else {
        // Below the horizon: dim bounce off the grass/dirt, not black. A black lower
        // hemisphere is what makes naive IBL look like objects float in a void.
        this._sky.copy(key.horizon).multiplyScalar(0.28);
      }
      for (let i = 0; i < PROBE_W; i++) {
        const az = ((i + 0.5) / PROBE_W) * Math.PI * 2 - Math.PI;
        const dir = [Math.cos(az) * Math.cos(Math.asin(elev)), elev, Math.sin(az) * Math.cos(Math.asin(elev))];
        const dot = sunDir ? Math.max(0, dir[0] * sunDir.x + dir[1] * sunDir.y + dir[2] * sunDir.z) : 0;
        const glow = Math.pow(dot, 40) * key.sunI * 2.2 + Math.pow(dot, 6) * key.sunI * 0.18;
        const o = (i + j * PROBE_W) * 4;
        d[o] = this._sky.r + key.sun.r * glow;
        d[o + 1] = this._sky.g + key.sun.g * glow;
        d[o + 2] = this._sky.b + key.sun.b * glow;
        d[o + 3] = 1;
      }
    }
    this.source.needsUpdate = true;
  }

  dispose() {
    if (!this.enabled) return;
    this.scene.environment = null;
    this._texture?.dispose();
    this.source.dispose();
    this.pmrem.dispose();
  }
}
