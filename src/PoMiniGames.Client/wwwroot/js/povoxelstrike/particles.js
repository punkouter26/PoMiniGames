// particles.js — GPU dust and smoke for PoVoxelStrike.
//
// One THREE.Points object, one draw call, a fixed ring buffer of particles. The CPU
// never touches a particle after it is spawned: the vertex shader integrates
// position = origin + velocity·t + ½·g·t² from a per-particle birth time, so a frame
// with 4000 live puffs costs exactly the same JS as a frame with none.
//
// That matters here because dust is spawned from the destruction hot path — a collapsing
// castle emits dozens of clusters in one carve, and a per-particle CPU update loop was
// the thing that made the old debris burst hitch.
//
// Spawning writes into the ring buffer and marks only the touched attribute range dirty
// (`addUpdateRange`), so a 12-particle puff uploads 12 particles, not 4000. Wrapping
// spawns split into two ranges rather than uploading the whole buffer.

import * as THREE from 'three';

const VERTEX = /* glsl */`
  attribute vec3 aVelocity;
  attribute vec4 aSeed;       // x: birth time, y: lifetime, z: size, w: spin/flicker seed
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uGravity;
  uniform float uPixelScale;  // drawingBufferHeight — keeps size stable across DPR
  varying vec3 vColor;
  varying float vAge;
  varying float vSeed;

  void main() {
    float age = (uTime - aSeed.x) / max(0.0001, aSeed.y);
    vAge = age;
    vColor = aColor;
    vSeed = aSeed.w;
    if (age < 0.0 || age > 1.0) {
      // Dead: collapse to a degenerate point behind the camera so it costs no fill.
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    float t = age * aSeed.y;
    // Drag: puffs slow down as they expand, or every plume looks like a firework.
    float drag = 1.0 - exp(-2.2 * t);
    vec3 pos = position + aVelocity * (drag / 2.2) + vec3(0.0, 0.5 * uGravity * t * t, 0.0);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    // Smoke grows as it ages; the 1/-z term is standard perspective size attenuation.
    float grow = aSeed.z * (0.45 + age * 1.6);
    gl_PointSize = max(1.0, grow * uPixelScale / max(0.001, -mv.z));
  }`;

const FRAGMENT = /* glsl */`
  varying vec3 vColor;
  varying float vAge;
  varying float vSeed;

  void main() {
    // Soft round sprite, generated rather than sampled — no texture to load, decode,
    // or keep resident, and it stays crisp at any point size.
    vec2 d = gl_PointCoord - 0.5;
    float r = dot(d, d) * 4.0;
    if (r > 1.0) discard;
    float soft = 1.0 - smoothstep(0.35, 1.0, r);
    // Fade in fast, out slow: a puff should appear instantly and linger.
    float fade = smoothstep(0.0, 0.08, vAge) * (1.0 - smoothstep(0.45, 1.0, vAge));
    float flicker = 0.85 + 0.15 * sin(vSeed * 30.0 + vAge * 12.0);
    gl_FragColor = vec4(vColor * flicker, soft * fade * 0.55);
  }`;

export class ParticleSystem {
  /** @param capacity max simultaneous particles; 0 disables the system entirely. */
  constructor(scene, capacity) {
    this.scene = scene;
    this.capacity = Math.max(0, capacity | 0);
    this.enabled = this.capacity > 0;
    this.cursor = 0;
    this.time = 0;
    if (!this.enabled) return;

    const n = this.capacity;
    this.positions = new Float32Array(n * 3);
    this.velocities = new Float32Array(n * 3);
    this.seeds = new Float32Array(n * 4);
    this.colors = new Float32Array(n * 3);
    // Birth time far in the past → age > 1 → the vertex shader discards them on frame 1.
    for (let i = 0; i < n; i++) { this.seeds[i * 4] = -1e6; this.seeds[i * 4 + 1] = 1; }

    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.BufferAttribute(this.velocities, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSeed = new THREE.BufferAttribute(this.seeds, 4).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aVelocity', this.aVel);
    g.setAttribute('aSeed', this.aSeed);
    g.setAttribute('aColor', this.aCol);
    // Particles move in the shader, so three's own bounds are always wrong. An infinite
    // sphere disables culling — cheaper and more correct than recomputing bounds.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uGravity: { value: -3.2 },  // lighter than the physics world: dust hangs
        uPixelScale: { value: 600 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);

    this._c = new THREE.Color();
  }

  /** Keep point size independent of canvas height / device pixel ratio. */
  setViewportHeight(pixels) {
    if (this.enabled) this.material.uniforms.uPixelScale.value = Math.max(1, pixels) * 0.5;
  }

  /**
   * Emit a puff.
   * @param position THREE.Vector3 origin
   * @param count particles to spawn (clamped to the remaining ring capacity per call)
   * @param opts { color, speed, spread, size, life, upward }
   */
  emit(position, count, opts = {}) {
    if (!this.enabled || count <= 0) return;
    const n = Math.min(count | 0, this.capacity);
    const {
      color = 0x9a8f7d, speed = 2.4, spread = 1, size = 0.5, life = 1.4, upward = 1.2,
    } = opts;
    this._c.set(color);

    const start = this.cursor;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % this.capacity;
      const p3 = i * 3, s4 = i * 4;
      this.positions[p3] = position.x + (Math.random() - 0.5) * spread * 0.4;
      this.positions[p3 + 1] = position.y + (Math.random() - 0.5) * spread * 0.4;
      this.positions[p3 + 2] = position.z + (Math.random() - 0.5) * spread * 0.4;

      // Cosine-ish hemisphere: mostly outward and up, never straight down.
      const theta = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random());
      const v = speed * (0.35 + Math.random() * 0.9);
      this.velocities[p3] = Math.cos(theta) * r * v;
      this.velocities[p3 + 1] = (upward + Math.random() * 0.8) * v * 0.5;
      this.velocities[p3 + 2] = Math.sin(theta) * r * v;

      this.seeds[s4] = this.time;
      this.seeds[s4 + 1] = life * (0.7 + Math.random() * 0.6);
      this.seeds[s4 + 2] = size * (0.6 + Math.random() * 0.9);
      this.seeds[s4 + 3] = Math.random();

      // Per-particle tint jitter so a plume is not one flat colour.
      const j = 0.82 + Math.random() * 0.36;
      this.colors[p3] = this._c.r * j;
      this.colors[p3 + 1] = this._c.g * j;
      this.colors[p3 + 2] = this._c.b * j;
    }
    this._markDirty(start, n);
    this.cursor = (start + n) % this.capacity;
  }

  /** Flag only the written slice(s). A wrap becomes two ranges, never a full re-upload. */
  _markDirty(start, count) {
    const attrs = [
      [this.aPos, 3], [this.aVel, 3], [this.aSeed, 4], [this.aCol, 3],
    ];
    const end = start + count;
    const ranges = end <= this.capacity
      ? [[start, count]]
      : [[start, this.capacity - start], [0, end - this.capacity]];
    for (const [attr, stride] of attrs) {
      attr.clearUpdateRanges();
      for (const [from, len] of ranges) attr.addUpdateRange(from * stride, len * stride);
      attr.needsUpdate = true;
    }
  }

  update(dt) {
    if (!this.enabled) return;
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
  }

  dispose() {
    if (!this.enabled) return;
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
