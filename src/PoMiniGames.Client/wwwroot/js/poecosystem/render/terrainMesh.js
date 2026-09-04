// terrainMesh.js — the island as one vertex-coloured mesh plus the water surface.
//
// Colours come from the biome and the live grass biomass, so grazing, fire and lava show
// up without rebuilding geometry: only the colour attribute is rewritten (per tile-sync).
//
// GFX option 7 keeps that contract and adds a surface to it. The material is still
// MeshLambertMaterial — the flat-shaded low-poly look is the art direction, not a
// limitation — but `onBeforeCompile` injects four terms the vertex colours cannot express:
//
//   GRAIN    two octaves of value noise in world space, so a tile is no longer one flat
//            facet of colour when the god stands on it.
//   STRATA   the same noise sampled without a vertical term, which smears into horizontal
//            banding on steep faces. On a cliff that reads as rock strata; on flat ground
//            it is invisible because the surface is already being grained.
//   ROCK     slope-blended grey. Anything past ~40° stops being soil regardless of biome,
//            which is what gives the mountains an edge the vertex palette never had.
//   WET      a darkening band either side of the waterline, so the beach meets the sea in
//            a damp margin instead of at a hard colour boundary.
//
// Lava and fire additionally get a real EMISSIVE channel, via a per-vertex `aGlow`
// attribute written by paint(). That is what makes them bloom in postProcess.js — before
// this they were flat orange vertex colours, which no bright-pass can find.
import * as THREE from 'three';
import { TILE, TILE_STATE, tileX, tileZ } from '../sim/terrain/tiles.js';
import { createWater } from './water.js';

// Base colours per tile type (linear-ish sRGB hex, picked to read at a distance).
const BIOME = {
  [TILE.OCEAN]: 0x0c4a6e, [TILE.BEACH]: 0xd8c48f, [TILE.GRASS]: 0x4e7f2f, [TILE.FOREST]: 0x1f5c2a,
  [TILE.HILL]: 0x6b7a4a, [TILE.MOUNTAIN]: 0x7a736b, [TILE.LAKE]: 0x0ea5e9, [TILE.VOLCANO]: 0x44403c,
};
const STATE_COLOUR = {
  [TILE_STATE.FIRE]: 0xf97316, [TILE_STATE.BURNT]: 0x2a2724, [TILE_STATE.LAVA]: 0xef4444,
  [TILE_STATE.COOLED]: 0x3f3a36, [TILE_STATE.BOULDER]: 0x8a8378,
};
// How hard each state glows. Fire flickers (the renderer drives uGlowPulse); lava is
// steady and hot; everything else is 0 and costs the shader a multiply.
const STATE_GLOW = { [TILE_STATE.FIRE]: 1.0, [TILE_STATE.LAVA]: 0.85 };
const DRY = new THREE.Color(0x8a7f4a);   // grass at zero biomass

const COMMON_VERT = `
#include <common>
attribute float aGlow;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vGlow;
`;

const COMMON_FRAG = `
#include <common>
uniform float uGlowPulse;
uniform float uDetail;      // 0 disables every injected term — the low-tier escape hatch
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vGlow;

float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x),
             mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

export function createTerrainMesh(terrain, { tier = 'high' } = {}) {
  const { size, height } = terrain;
  const cs = size + 1;
  const geometry = new THREE.PlaneGeometry(size, size, size, size);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position;
  // PlaneGeometry rows run +x then -z; translate so tile (0,0) sits at world (0,0).
  for (let j = 0; j < cs; j++) {
    for (let i = 0; i < cs; i++) {
      const v = j * cs + i;
      pos.setX(v, i);
      pos.setZ(v, j);
      pos.setY(v, height[j * cs + i]);
    }
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cs * cs * 3), 3));
  const glowAttr = new THREE.BufferAttribute(new Float32Array(cs * cs), 1);
  glowAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aGlow', glowAttr);

  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  // Held outside onBeforeCompile so the renderer can drive them per frame: the callback
  // runs once, at first compile, and the uniform objects it captures are these.
  const uniforms = {
    uGlowPulse: { value: 1 },
    uDetail: { value: tier === 'low' ? 0 : 1 },
  };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowPulse = uniforms.uGlowPulse;
    shader.uniforms.uDetail = uniforms.uDetail;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', COMMON_VERT)
      .replace('#include <beginnormal_vertex>', `
        #include <beginnormal_vertex>
        vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
      `)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGlow = aGlow;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', COMMON_FRAG)
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        if (uDetail > 0.5) {
          // Grain: two octaves, the second at a prime-ish ratio so the pattern does not
          // beat against the 1 m tile grid.
          float g = tNoise(vWorldPos.xz * 0.65) * 0.62 + tNoise(vWorldPos.xz * 2.7) * 0.38;
          diffuseColor.rgb *= 0.86 + g * 0.28;

          // Strata: no vertical term in the sample, so on a cliff this smears into bands.
          // On flat ground the slope mask below is ~0 and it never shows.
          float slope = 1.0 - clamp(vWorldNormal.y, 0.0, 1.0);
          float steep = smoothstep(0.22, 0.62, slope);
          float bands = tNoise(vec2(vWorldPos.y * 3.1, (vWorldPos.x + vWorldPos.z) * 0.18));
          vec3 rock = vec3(0.36, 0.34, 0.32) * (0.72 + bands * 0.5);
          diffuseColor.rgb = mix(diffuseColor.rgb, rock, steep * 0.72);

          // Wet margin: darker and slightly more saturated where the tide would reach.
          float wet = 1.0 - smoothstep(-0.15, 1.1, vWorldPos.y);
          diffuseColor.rgb *= 1.0 - wet * 0.34;
        }
      `)
      .replace('#include <emissivemap_fragment>', `
        #include <emissivemap_fragment>
        // vGlow is 0 for all but burning and molten tiles, so this is a multiply-add for
        // the whole island and a real light source for the handful of tiles that are lit.
        totalEmissiveRadiance += diffuseColor.rgb * vGlow * uGlowPulse * 2.4;
      `);
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'island';

  const water = createWater(terrain, { tier });

  const colour = new THREE.Color();

  /** Recolour every vertex from the tile type, its state and the grass biomass (0..255). */
  function paint(tileState, grass) {
    const colours = geometry.attributes.color;
    const glow = geometry.attributes.aGlow;
    for (let j = 0; j < cs; j++) {
      for (let i = 0; i < cs; i++) {
        // A corner takes the colour of the tile down-right of it (clamped at the edges).
        const t = Math.min(size - 1, i) + Math.min(size - 1, j) * size;
        const state = tileState?.[t] ?? 0;
        const stateColour = STATE_COLOUR[state];
        if (stateColour !== undefined) colour.setHex(stateColour);
        else {
          colour.setHex(BIOME[terrain.type[t]] ?? 0x555555);
          // lerp does not mutate its argument, so the constant can be passed directly.
          if (grass && (terrain.type[t] === TILE.GRASS || terrain.type[t] === TILE.HILL)) colour.lerp(DRY, 1 - grass[t] / 255);
        }
        const v = j * cs + i;
        colours.setXYZ(v, colour.r, colour.g, colour.b);
        glow.setX(v, STATE_GLOW[state] ?? 0);
      }
    }
    colours.needsUpdate = true;
    glow.needsUpdate = true;
  }
  paint(null, null);

  return {
    mesh,
    water: water.mesh,
    paint,
    /**
     * Per frame. `time` drives the fire flicker on the emissive channel and the water's
     * wave clock; `sky` is the object lighting.update() returns.
     */
    update(time, sky) {
      // One shared flicker for every burning tile: fires on an island genuinely do pulse
      // together at a distance, and a per-tile phase would need a second attribute upload.
      uniforms.uGlowPulse.value = 0.78 + Math.sin(time * 7.3) * 0.14 + Math.sin(time * 11.9) * 0.08;
      water.update(time, sky);
    },
    dispose() { geometry.dispose(); material.dispose(); water.dispose(); },
    tileAt: (x, z) => Math.min(size - 1, Math.max(0, x | 0)) + Math.min(size - 1, Math.max(0, z | 0)) * size,
    tileX: (i) => tileX(i, size), tileZ: (i) => tileZ(i, size),
  };
}
