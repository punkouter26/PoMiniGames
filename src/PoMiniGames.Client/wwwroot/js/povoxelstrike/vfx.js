// vfx.js — screen feel and scene polish for PoVoxelStrike:
//   • post-processing (EffectComposer: render → UnrealBloom → output), guarded so a
//     composer failure falls back to the plain renderer instead of killing the game
//   • trauma-based screen shake (additive, decays exponentially; applied as a small
//     camera rotation AFTER the follow/lookAt so it never fights the follow lerp)
//   • damage flash: a DOM vignette overlay inside the canvas host (cheaper and
//     crisper than a full-screen shader pass)
//   • muzzle flash: one pooled PointLight — never allocated per shot
//   • blast shockwaves: camera-facing additive rings
//   • gradient sky dome (replaces the flat clear color)
//
// prefers-reduced-motion turns off shake and the damage flash (the two effects that
// move or strobe the whole viewport); bloom, rings, and the sky are static enough
// to keep.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const SHOCK_LIFE_S = 0.45;

export class Vfx {
  constructor(renderer, scene, camera, host) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.host = host;
    this.reducedMotion = !!(window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    this.trauma = 0;
    this.time = 0;
    this.shocks = []; // { mesh, life }

    // Composer is best-effort: SwiftShader/odd drivers can refuse the bloom targets,
    // and the game must render either way.
    this.composer = null;
    this.bloomPass = null;
    try {
      const size = renderer.getSize(new THREE.Vector2());
      this.composer = new EffectComposer(renderer);
      this.composer.addPass(new RenderPass(scene, camera));
      this.bloomPass = new UnrealBloomPass(size, 0.35, 0.5, 0.82);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    } catch (e) {
      console.warn('[povoxelstrike/vfx] post-processing unavailable, rendering plain:', e);
      this.composer = null;
    }

    // Damage vignette overlay (styled in PoVoxelStrikePage.razor.css via ::deep).
    this.hitOverlay = document.createElement('div');
    this.hitOverlay.className = 'pvs-hit';
    this.hitOverlay.style.opacity = '0';
    host.appendChild(this.hitOverlay);
    this._hitOpacity = 0;

    // Pooled muzzle light.
    this.muzzleLight = new THREE.PointLight(0xffc46b, 0, 14, 1.8);
    this.muzzleLight.visible = false;
    scene.add(this.muzzleLight);
    this._muzzleT = 0;

    this.shockGeometry = new THREE.RingGeometry(0.55, 1, 28);
    this.shockMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc27a, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
  }

  /** Gradient sky dome; call once after the scene exists. Returns the dome mesh. */
  buildSky() {
    const geometry = new THREE.SphereGeometry(430, 24, 14);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x151b2c) },
        horizonColor: { value: new THREE.Color(0x46536e) },
      },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        varying vec3 vWorld;
        void main() {
          float h = clamp(normalize(vWorld).y, 0.0, 1.0);
          vec3 c = mix(horizonColor, topColor, pow(h, 0.55));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(geometry, material);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.scene.background = null; // the dome is the background now
    return this.sky;
  }

  resize(width, height) {
    this.composer?.setSize(width, height);
  }

  /** Add shake trauma, 0..1 per event. Shake amplitude is trauma², so small events whisper. */
  addShake(amount) {
    if (this.reducedMotion) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Red vignette pulse; intensity 0..1. */
  flashDamage(intensity) {
    if (this.reducedMotion) return;
    this._hitOpacity = Math.min(0.85, this._hitOpacity + intensity);
  }

  muzzleFlash(position) {
    this.muzzleLight.position.copy(position);
    this.muzzleLight.intensity = 55;
    this.muzzleLight.visible = true;
    this._muzzleT = 0.06;
  }

  shockwave(position) {
    const mesh = new THREE.Mesh(this.shockGeometry, this.shockMaterial.clone());
    mesh.position.copy(position);
    this.scene.add(mesh);
    this.shocks.push({ mesh, life: SHOCK_LIFE_S });
  }

  update(dt) {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);

    if (this._muzzleT > 0) {
      this._muzzleT -= dt;
      this.muzzleLight.intensity *= Math.exp(-dt * 40);
      if (this._muzzleT <= 0) this.muzzleLight.visible = false;
    }

    if (this._hitOpacity > 0.005) {
      this._hitOpacity *= Math.exp(-dt * 4.5);
      this.hitOverlay.style.opacity = this._hitOpacity.toFixed(3);
    } else if (this.hitOverlay.style.opacity !== '0') {
      this.hitOverlay.style.opacity = '0';
      this._hitOpacity = 0;
    }

    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const s = this.shocks[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        s.mesh.material.dispose();
        this.shocks.splice(i, 1);
        continue;
      }
      const t = 1 - s.life / SHOCK_LIFE_S;
      s.mesh.scale.setScalar(1 + t * 14);
      s.mesh.material.opacity = 0.8 * (1 - t);
      s.mesh.quaternion.copy(this.camera.quaternion); // billboard toward the camera
    }
  }

  /**
   * Apply shake to the camera. Call AFTER the follow/lookAt has oriented it.
   * Layered sines at incommensurate frequencies read as noise without allocating one.
   */
  applyShake() {
    if (this.trauma <= 0) return;
    const a = this.trauma * this.trauma;
    const t = this.time;
    const yaw = a * 0.05 * (Math.sin(t * 31.7) + 0.6 * Math.sin(t * 47.3));
    const pitch = a * 0.04 * (Math.sin(t * 37.1) + 0.6 * Math.sin(t * 53.9));
    const roll = a * 0.025 * Math.sin(t * 41.3);
    this.camera.rotateY(yaw);
    this.camera.rotateX(pitch);
    this.camera.rotateZ(roll);
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    for (const s of this.shocks) { this.scene.remove(s.mesh); s.mesh.material.dispose(); }
    this.shocks.length = 0;
    this.shockGeometry.dispose();
    this.shockMaterial.dispose();
    this.scene.remove(this.muzzleLight);
    if (this.sky) {
      this.scene.remove(this.sky);
      this.sky.geometry.dispose();
      this.sky.material.dispose();
    }
    // Composer render targets hold GPU memory; passes hold their own (bloom's mips).
    this.bloomPass?.dispose?.();
    this.composer?.dispose?.();
    this.hitOverlay.remove();
  }
}
