// water.js — the ocean and lakes as a real surface (GFX option 5).
//
// What was here before: one `PlaneGeometry` with a `MeshLambertMaterial` at opacity 0.75.
// Flat, uniformly cyan, no horizon, and the shoreline was a hard line where the terrain
// mesh stopped. It read as coloured paper, which is a shame on an island game where water
// is a third of every frame.
//
// What it is now, all in one ShaderMaterial with no textures beyond a 201x201 depth bake:
//   • Three crossed sine trains displace the surface and their analytic derivatives give
//     the normal — no normal map, and the waves are the same maths on both sides.
//   • Depth-graded colour: the shallows over the beach shelf go turquoise, the deep ocean
//     goes near-black blue. The depth comes from the terrain heightmap the sim already
//     transferred, baked once into a DataTexture at world load.
//   • Fresnel: the water is transparent looking down and mirror-bright at grazing angles.
//     This is the single term that makes a flat plane stop looking flat.
//   • A sun specular lobe on the wave normals, tinted by whatever colour the sun is at
//     that hour, so the water carries the day/night cycle rather than ignoring it.
//   • Foam where the depth ramps to zero, modulated by the wave crest and drifting noise,
//     so the shoreline moves.
//
// The depth bake is why this takes a `terrain`: the shader needs to know how deep the
// water is at a point, and the CPU already has that. Sampling a baked texture is one tap;
// re-deriving it in the shader would mean shipping the heightfield to the GPU anyway.
import * as THREE from 'three';

const VERT = `
uniform float uTime;
uniform vec2 uOrigin;      // world XZ of the terrain's (0,0) corner, for the depth lookup
uniform float uSpan;       // terrain size in metres
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vDepthUv;

// Three trains at incommensurable angles and speeds. Two look like a grid; four costs more
// than it adds at this wave height.
const vec3 A_DIR = vec3(0.86, 0.0, 0.51);
const vec3 B_DIR = vec3(-0.41, 0.0, 0.91);
const vec3 C_DIR = vec3(0.62, 0.0, -0.78);

void main() {
  vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;

  float a = dot(world.xz, A_DIR.xz) * 0.42 + uTime * 0.85;
  float b = dot(world.xz, B_DIR.xz) * 0.71 + uTime * 1.31;
  float c = dot(world.xz, C_DIR.xz) * 1.30 + uTime * 2.10;

  float h = sin(a) * 0.20 + sin(b) * 0.11 + sin(c) * 0.05;
  world.y += h;

  // dh/dx and dh/dz of the same sum — the normal is exact rather than sampled, which is
  // what keeps the specular from crawling as the camera moves.
  float dx = cos(a) * 0.42 * A_DIR.x * 0.20 + cos(b) * 0.71 * B_DIR.x * 0.11 + cos(c) * 1.30 * C_DIR.x * 0.05;
  float dz = cos(a) * 0.42 * A_DIR.z * 0.20 + cos(b) * 0.71 * B_DIR.z * 0.11 + cos(c) * 1.30 * C_DIR.z * 0.05;
  vNormal = normalize(vec3(-dx, 1.0, -dz));

  vWorld = world;
  vDepthUv = (world.xz - uOrigin) / uSpan;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FRAG = `
uniform sampler2D uDepth;   // R = water depth 0..1 (1 = deepest), sampled at the terrain grid
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;
uniform float uNight;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vDepthUv;

// Cheap value noise — two octaves is enough to break the foam line up.
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  // Outside the island's footprint there is no bake — that is open ocean, so clamp to full
  // depth rather than letting the sampler wrap a shoreline round the horizon.
  float inside = step(0.0, vDepthUv.x) * step(vDepthUv.x, 1.0) * step(0.0, vDepthUv.y) * step(vDepthUv.y, 1.0);
  float depth = mix(1.0, texture2D(uDepth, clamp(vDepthUv, 0.0, 1.0)).r, inside);

  vec3 view = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vNormal);

  // Fresnel (Schlick). Water's F0 is ~0.02: almost perfectly transparent head-on and
  // almost perfectly reflective at the horizon, which is the whole look.
  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 5.0);

  vec3 body = mix(uShallow, uDeep, smoothstep(0.02, 0.55, depth));
  vec3 col = mix(body, uSkyColor, fres * 0.85);

  // Blinn-Phong sun glint. Tightened at night so the moonlit sheen is a line rather than
  // a wash — the sun colour is already dimmed by lighting.js at that hour.
  vec3 halfway = normalize(uSunDir + view);
  float spec = pow(max(dot(n, halfway), 0.0), mix(90.0, 220.0, uNight));
  col += uSunColor * spec * (1.0 - uNight * 0.55) * 1.6;

  // Foam: a band where the bed rises to meet the surface, cut up by drifting noise and
  // pushed by the wave crest so the line advances and retreats.
  float crest = smoothstep(0.02, 0.16, (1.0 - n.y) * 6.0);
  float shore = 1.0 - smoothstep(0.0, 0.085, depth);
  float grain = noise(vWorld.xz * 1.7 + vec2(uTime * 0.35, uTime * -0.22));
  float foam = clamp(shore * (0.55 + grain * 0.75) + crest * shore * 0.9, 0.0, 1.0) * inside;
  col = mix(col, vec3(0.93, 0.97, 1.0), foam * 0.85);

  // Alpha: see the bed in the shallows, opaque in the deep, and never fully transparent at
  // a grazing angle however shallow it is (that is where the reflection lives).
  float alpha = clamp(mix(0.34, 0.94, smoothstep(0.0, 0.3, depth)) + fres * 0.5 + foam * 0.6, 0.0, 1.0);

  float dist = length(cameraPosition - vWorld);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  gl_FragColor = vec4(mix(col, uFogColor, fog), alpha);
}
`;

/**
 * Bake the water depth at every terrain corner into an R8 texture. 0 where the bed is at
 * or above the surface, 1 at the heightmap's -3 m floor.
 */
function bakeDepth(terrain) {
  const cs = terrain.size + 1;
  const data = new Uint8Array(cs * cs);
  for (let i = 0; i < cs * cs; i++) {
    data[i] = Math.max(0, Math.min(255, Math.round((-terrain.height[i] / 3) * 255)));
  }
  const tex = new THREE.DataTexture(data, cs, cs, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * @param {{size:number, height:Float32Array|Int16Array}} terrain the renderer's terrainApi
 * @param {{ tier?: string }} [opts] segment count follows the tier — the waves are vertex
 *   work, so this is the one dial that matters for cost.
 */
export function createWater(terrain, { tier = 'high' } = {}) {
  const size = terrain.size;
  const segments = tier === 'high' ? 192 : tier === 'medium' ? 96 : 48;
  const geometry = new THREE.PlaneGeometry(size * 3, size * 3, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const depth = bakeDepth(terrain);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOrigin: { value: new THREE.Vector2(0, 0) },
      uSpan: { value: size },
      uDepth: { value: depth },
      // Hex-constructed Colors are already in three's linear working space
      // (ColorManagement is on by default since r152) — converting again would wash them out.
      uShallow: { value: new THREE.Color(0x2fb6c8) },
      uDeep: { value: new THREE.Color(0x062f4a) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.4) },
      uSunColor: { value: new THREE.Color(0xfff2df) },
      uSkyColor: { value: new THREE.Color(0x8ec5ff) },
      uFogColor: { value: new THREE.Color(0x8ec5ff) },
      uFogDensity: { value: 0.006 },
      uNight: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,      // the surface must not occlude the bed it is meant to reveal
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(size / 2, 0, size / 2);
  mesh.renderOrder = 4;     // after the island, before the particle pools
  mesh.name = 'water';

  const u = material.uniforms;
  return {
    mesh,
    /**
     * @param {number} time seconds
     * @param {{ sunDir: THREE.Vector3, sunColour: THREE.Color, sky: THREE.Color, night: number, fogDensity: number }} sky
     *   the `info` object lighting.update() returns — same object every frame, by design.
     */
    update(time, sky) {
      u.uTime.value = time;
      if (!sky) return;
      u.uSunDir.value.copy(sky.sunDir);
      u.uSunColor.value.copy(sky.sunColour);
      u.uSkyColor.value.copy(sky.sky);
      u.uFogColor.value.copy(sky.sky);
      u.uFogDensity.value = sky.fogDensity;
      u.uNight.value = sky.night;
    },
    dispose() { geometry.dispose(); material.dispose(); depth.dispose(); },
  };
}
