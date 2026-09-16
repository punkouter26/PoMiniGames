// materials.js — the surface detail every creature, tree, hut and prop shares.
//
// The art direction is flat-shaded low-poly Lambert, and that stays. What was missing is
// everything a flat facet cannot say on its own: a silhouette against the ground, a
// surface that is not one uniform tone from nose to tail, leaves that move. Rather than
// swapping materials (a PBR material would fight the look and cost more per pixel), one
// onBeforeCompile hook injects three terms into MeshLambertMaterial:
//
//   RIM     a Fresnel-weighted light on the silhouette, tinted by the sky. A rabbit on
//           grass is brown on green; the rim is what separates them at twenty metres.
//   MOTTLE  world-space value noise on the diffuse colour — fur, bark, stone grain — at
//           a scale the caller chooses. Sampled in world space so instanced meshes get
//           different patterns without an extra attribute.
//   SWAY    a vertex displacement that grows with local height, driven by a shared clock
//           and offset by world position so a forest does not move in lockstep. Only the
//           crowns and bushes ask for it.
//
// One clock. `materialClock.value` is set once per frame by the renderer and every hooked
// material reads it, so a new material never needs its own uniform plumbing.
import * as THREE from 'three';

export const materialClock = { value: 0 };
export const materialDetail = { value: 1 };   // 0 on the low tier: every injected term collapses
export const materialSeason = { value: 0 };   // 0 = Spring, 1 = Summer, 2 = Autumn, 3 = Winter
export const materialSnow = { value: 0 };     // 0..1 snow coverage factor

const NOISE = `
float mHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float mNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mHash(i), mHash(i + vec2(1.0, 0.0)), u.x),
             mix(mHash(i + vec2(0.0, 1.0)), mHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

/**
 * Hook a Lambert material. Returns the same material for chaining.
 * @param {THREE.MeshLambertMaterial} material
 * @param {{ rim?: number, rimColor?: number, mottle?: number, mottleScale?: number, sway?: number, swayHeight?: number }} o
 *   rim: strength (0 = off) · mottle: amplitude 0..1 · mottleScale: world units per cycle ·
 *   sway: metres of displacement at the top · swayHeight: local height over which sway ramps
 */
export function enhanceLambert(material, { rim = 0.35, rimColor = 0xbfd4ff, mottle = 0.18, mottleScale = 1.6, sway = 0, swayHeight = 3 } = {}) {
  const rimCol = new THREE.Color(rimColor);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMatTime = materialClock;
    shader.uniforms.uMatDetail = materialDetail;
    shader.uniforms.uSeason = materialSeason;
    shader.uniforms.uSnow = materialSnow;
    shader.uniforms.uRim = { value: rim };
    shader.uniforms.uRimColor = { value: rimCol };
    shader.uniforms.uMottle = { value: mottle };
    shader.uniforms.uMottleScale = { value: 1 / Math.max(0.05, mottleScale) };
    shader.uniforms.uSway = { value: sway };
    shader.uniforms.uSwayHeight = { value: Math.max(0.1, swayHeight) };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        uniform float uMatTime;
        uniform float uSway;
        uniform float uSwayHeight;
        varying vec3 vMatWorld;
      `)
      // Sway before projection, in object space, so the instance matrix still applies.
      // The phase comes from the instance's world offset (its matrix translation) so
      // neighbouring trees never move together.
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        if (uSway > 0.0) {
          #ifdef USE_INSTANCING
            vec2 anchor = instanceMatrix[3].xz;
          #else
            vec2 anchor = vec2(0.0);
          #endif
          float lift = clamp((transformed.y + uSwayHeight * 0.5) / uSwayHeight, 0.0, 1.0);
          float phase = uMatTime * 1.35 + anchor.x * 0.31 + anchor.y * 0.27;
          transformed.x += sin(phase) * uSway * lift * lift;
          transformed.z += cos(phase * 0.83 + 1.7) * uSway * 0.6 * lift * lift;
        }
      `)
      .replace('#include <project_vertex>', `
        #include <project_vertex>
        #ifdef USE_INSTANCING
          vMatWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vMatWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        uniform float uMatDetail;
        uniform float uRim;
        uniform vec3 uRimColor;
        uniform float uMottle;
        uniform float uMottleScale;
        uniform float uSeason;
        uniform float uSnow;
        varying vec3 vMatWorld;
        ${NOISE}
      `)
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        if (uMatDetail > 0.5 && uMottle > 0.0) {
          // Two octaves in world space; the vertical term keeps the pattern from streaking
          // down a trunk or a leg.
          vec3 w = vMatWorld * uMottleScale;
          float m = mNoise(w.xz + w.y * 0.7) * 0.6 + mNoise(w.xz * 2.9 - w.y * 1.3) * 0.4;
          diffuseColor.rgb *= 1.0 - uMottle * 0.5 + m * uMottle;
        }
        // Seasonal effects:
        if (uSnow > 0.05) {
          float upNorm = clamp(normal.y, 0.0, 1.0);
          float snowFactor = smoothstep(0.2, 0.75, upNorm) * uSnow;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 0.98), snowFactor * 0.85);
        } else if (uSeason > 1.5 && uSeason < 2.5) {
          // Warm amber shift in Autumn
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(diffuseColor.r * 1.25, diffuseColor.g * 0.8, diffuseColor.b * 0.45), 0.35);
        }
      `)
      // Rim after the lighting sum: an additive, view-dependent term on the silhouette.
      .replace('#include <opaque_fragment>', `
        if (uMatDetail > 0.5 && uRim > 0.0) {
          vec3 viewDir = normalize(vViewPosition);
          float rimF = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 3.2);
          outgoingLight += uRimColor * rimF * uRim * (0.35 + 0.65 * diffuseColor.g);
        }
        #include <opaque_fragment>
      `);
  };
  // A hooked material must not share a program with an unhooked one of the same type.
  material.customProgramCacheKey = () => `poeco-enh-${rim}-${mottle}-${mottleScale}-${sway}-${swayHeight}`;
  return material;
}
