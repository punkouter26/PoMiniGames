// decals.js — scorch marks left by blasts and dig hits.
//
// A fixed pool of camera-independent quads in ONE InstancedMesh, so the whole history of
// a firefight costs a single draw call. Each instance carries its own age, radius and
// tint in instanced attributes; the fragment shader draws a soft, noisy ring procedurally
// so there is no texture to author or load.
//
// Deliberately NOT three's DecalGeometry: that projects new geometry onto the target mesh,
// and every surface in this game is re-meshed the moment it is dug. A projected decal
// would be orphaned by the very explosion that created it. A flat oriented quad survives
// the re-mesh; the cost is that a decal straddling a fresh crater lip floats slightly.
//
// Oldest-first reuse: when the pool is full the next mark overwrites the oldest, which is
// the behaviour players expect — the battle's recent history stays visible.

import * as THREE from 'three';

const VERTEX = /* glsl */`
  attribute vec4 aDecal;    // xyz: centre, w: radius
  attribute vec4 aBasis;    // xyz: surface normal, w: birth time
  attribute vec4 aTint;     // rgb: colour, a: lifetime (0 = permanent)
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vFade;

  void main() {
    float life = aTint.a;
    float fade = 1.0;
    if (life > 0.0) fade = 1.0 - clamp((uTime - aBasis.w) / life, 0.0, 1.0);
    vFade = fade;
    vTint = aTint.rgb;
    vUv = uv;
    if (aDecal.w <= 0.0 || fade <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

    // Build a frame around the surface normal. The up-vector fallback matters: the
    // perimeter wall and cliff faces are vertical, and cross(n, up) degenerates there.
    vec3 n = normalize(aBasis.xyz);
    vec3 ref = abs(n.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 t = normalize(cross(ref, n));
    vec3 b = cross(n, t);
    // Lift along the normal so the quad wins the depth test against the surface it
    // marks; polygonOffset alone is not enough on a stepped voxel heightfield.
    vec3 world = aDecal.xyz + n * 0.06
      + (t * position.x + b * position.y) * aDecal.w;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }`;

const FRAGMENT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vFade;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    // Ragged edge: a smooth disc reads as a decal, a noisy one reads as a burn.
    float ang = atan(d.y, d.x);
    float wobble = 0.82 + 0.18 * hash(vec2(floor(ang * 6.0), 3.0));
    float edge = 1.0 - smoothstep(wobble * 0.55, wobble, r);
    // Hot centre, sooty rim.
    float core = 1.0 - smoothstep(0.0, 0.55, r);
    vec3 c = mix(vTint * 0.35, vTint, core);
    gl_FragColor = vec4(c, edge * vFade * 0.85);
  }`;

export class DecalField {
  /** @param capacity max simultaneous marks; 0 disables the field entirely. */
  constructor(scene, capacity) {
    this.scene = scene;
    this.capacity = Math.max(0, capacity | 0);
    this.enabled = this.capacity > 0;
    this.cursor = 0;
    this.time = 0;
    if (!this.enabled) return;

    const n = this.capacity;
    this.decal = new Float32Array(n * 4);
    this.basis = new Float32Array(n * 4);
    this.tint = new Float32Array(n * 4);

    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(2, 2);
    g.index = quad.index;
    g.attributes.position = quad.attributes.position;
    g.attributes.uv = quad.attributes.uv;
    g.instanceCount = n;
    this.aDecal = new THREE.InstancedBufferAttribute(this.decal, 4).setUsage(THREE.DynamicDrawUsage);
    this.aBasis = new THREE.InstancedBufferAttribute(this.basis, 4).setUsage(THREE.DynamicDrawUsage);
    this.aTint = new THREE.InstancedBufferAttribute(this.tint, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aDecal', this.aDecal);
    g.setAttribute('aBasis', this.aBasis);
    g.setAttribute('aTint', this.aTint);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1; // under the particles, over the terrain
    scene.add(this.mesh);
    this._c = new THREE.Color();
  }

  /**
   * Stamp a mark.
   * @param position THREE.Vector3 contact point
   * @param normal THREE.Vector3 surface normal (falls back to straight up)
   * @param opts { radius, color, life } — life 0 keeps the mark for the whole match
   */
  stamp(position, normal, opts = {}) {
    if (!this.enabled) return;
    const { radius = 1.6, color = 0x1a1410, life = 0 } = opts;
    const i = this.cursor;
    const o = i * 4;
    this.decal[o] = position.x;
    this.decal[o + 1] = position.y;
    this.decal[o + 2] = position.z;
    this.decal[o + 3] = radius * (0.8 + Math.random() * 0.45);
    const n = normal && normal.lengthSq() > 0.0001 ? normal : { x: 0, y: 1, z: 0 };
    this.basis[o] = n.x;
    this.basis[o + 1] = n.y;
    this.basis[o + 2] = n.z;
    this.basis[o + 3] = this.time;
    this._c.set(color);
    this.tint[o] = this._c.r;
    this.tint[o + 1] = this._c.g;
    this.tint[o + 2] = this._c.b;
    this.tint[o + 3] = life;

    for (const attr of [this.aDecal, this.aBasis, this.aTint]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(o, 4);
      attr.needsUpdate = true;
    }
    this.cursor = (i + 1) % this.capacity;
  }

  update(dt) {
    if (!this.enabled) return;
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
  }

  dispose() {
    if (!this.enabled) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
