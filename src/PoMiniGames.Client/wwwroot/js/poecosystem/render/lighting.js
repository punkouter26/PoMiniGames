// lighting.js — sun, sky, atmosphere and the day/night cycle (SPEC §8: 120 s per cycle).
// The shadow camera follows the player, so a 2048 map covers the ~80 m the god can
// actually see rather than the whole 200 m island (the trick from povoxelstrike/game.js).
//
// Beyond the sun and the shadow camera this module now owns the AIR (GFX option 6):
//
//   FOG      FogExp2 rather than the old linear Fog, with the density riding the clock —
//            thin at midday, thick and warm at dawn and dusk, moderate at night. Exponential
//            fog has no far plane to pop at, which matters on an island where the horizon
//            is always water.
//   MIST     a ground layer that pools in the valleys at dawn. This is a single horizontal
//            plane with a noise shader, not real volumetrics: height fog done properly means
//            injecting a term into every material in the scene, and the plane gets most of
//            the look for one transparent draw and zero coupling.
//
// It also publishes what the water shader and the god-ray pass need — sun direction, sun
// colour, the night factor and the fog density — so those two never have to re-derive the
// time of day from the clock and drift out of step with the sky.
import * as THREE from 'three';

const SHADOW_HALF = 45;

// Night is deliberately mild (2026-09-02: user call) — the sky darkens slightly and the
// sun dims, but light floors stay high enough that creatures and terrain remain clearly
// observable around the clock. The scene must never become a dark screen.
const DAY_SKY = new THREE.Color(0x8ec5ff);
const NIGHT_SKY = new THREE.Color(0x2a3c5a);
const DUSK_SKY = new THREE.Color(0xf59e0b);
const DAY_SUN = new THREE.Color(0xfff2df);
const NIGHT_SUN = new THREE.Color(0x9db4d8);

const MIST_WHITE = new THREE.Color(0xffffff);
const MIST_Y = 1.15;
const MIST_SPAN = 520;

const MIST_VERT = `
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const MIST_FRAG = `
uniform vec3 uColor;
uniform float uTime;
uniform float uStrength;   // 0 = no mist at all; the plane is hidden entirely at 0
varying vec3 vWorld;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  vec2 p = vWorld.xz * 0.035;
  float n = noise(p + vec2(uTime * 0.011, uTime * -0.008)) * 0.62
          + noise(p * 2.7 - vec2(uTime * 0.019, 0.0)) * 0.38;
  n = smoothstep(0.34, 0.86, n);

  // Two fades keep the plane from ever being seen as a plane: it thins out at distance
  // (so there is no visible edge at the horizon) and it thins as the god climbs above it,
  // which is what makes flying up out of the mist read correctly.
  float dist = length(cameraPosition.xz - vWorld.xz);
  float far = 1.0 - smoothstep(70.0, 250.0, dist);
  float above = 1.0 - smoothstep(3.0, 26.0, cameraPosition.y - vWorld.y);

  float a = n * far * above * uStrength;
  if (a <= 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

export function createLighting(scene, { shadows = true, shadowMapSize = 2048, tier = 'high' } = {}) {
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

  // The fog is owned here rather than by the renderer: its colour and density both track
  // the same `elevation` the sun does, and splitting that across two files is how a sky
  // and its haze end up disagreeing about what time it is.
  const fog = new THREE.FogExp2(DAY_SKY.getHex(), 0.0045);
  scene.fog = fog;

  // Mist is the one purely decorative thing here, so it is the first to go on a weak GPU.
  let mist = null;
  if (tier !== 'low') {
    const geo = new THREE.PlaneGeometry(MIST_SPAN, MIST_SPAN, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xdfe9f5) },
        uTime: { value: 0 },
        uStrength: { value: 0 },
      },
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const plane = new THREE.Mesh(geo, mat);
    plane.position.y = MIST_Y;
    plane.renderOrder = 6;          // over the water, under the particle pools
    plane.frustumCulled = false;
    plane.name = 'mist';
    plane.visible = false;
    scene.add(plane);
    mist = { plane, mat };
  }

  const sky = new THREE.Color();
  const sunColour = new THREE.Color();
  const sunDir = new THREE.Vector3(0, 1, 0);
  // Reused so update() allocates nothing at 60 fps — it is called every frame.
  const info = { sky, sunColour, sunDir, night: 0, day: 1, dusk: 0, fogDensity: 0.0045 };

  return {
    sun, hemi, ambient, fog,
    get mist() { return mist?.plane ?? null; },

    /**
     * dayFraction 0..1 (0 = midnight). Returns the shared sky description: the renderer
     * uses `sky` for the clear colour, the water shader takes the sun and the night
     * factor, and the god-ray pass takes the sun's world position off `sun`.
     */
    update(dayFraction, player, time = 0) {
      const angle = (dayFraction - 0.25) * Math.PI * 2;      // 0.25 = sunrise
      const elevation = Math.sin(angle);
      const dist = 120;
      sun.position.set(player.x + Math.cos(angle) * dist, Math.max(4, elevation * dist), player.z + 60);
      sun.target.position.set(player.x, 0, player.z);
      sun.target.updateMatrixWorld();
      sunDir.set(sun.position.x - player.x, sun.position.y, sun.position.z - player.z).normalize();

      const day = Math.max(0, elevation);
      const dusk = Math.max(0, 1 - Math.abs(elevation) * 4);  // brief warm band at the horizon
      const night = 1 - day;
      sky.copy(NIGHT_SKY).lerp(DAY_SKY, day).lerp(DUSK_SKY, dusk * 0.5);
      sunColour.copy(NIGHT_SUN).lerp(DAY_SUN, day);
      sun.color.copy(sunColour);
      sun.intensity = 0.55 + day * 1.6;      // floors keep the night watchable
      hemi.intensity = 0.55 + day * 0.6;
      ambient.intensity = 0.34 + day * 0.12;

      // Haze thickens at both ends of the day. The dusk term dominates because that is
      // when the shafts are longest and the fog is what they scatter through.
      fog.density = 0.0040 + dusk * 0.0085 + night * 0.0035;
      fog.color.copy(sky);

      if (mist) {
        // Mist belongs to the cold hours: a dawn band, thinning through the morning, with
        // a lesser night presence. Midday has none.
        const dawn = Math.max(0, 1 - Math.abs(dayFraction - 0.27) * 9);
        const strength = Math.min(0.85, dawn * 0.75 + night * 0.28);
        mist.mat.uniforms.uStrength.value = strength;
        mist.mat.uniforms.uTime.value = time;
        mist.mat.uniforms.uColor.value.copy(sky).lerp(MIST_WHITE, 0.55);
        mist.plane.visible = strength > 0.01;
        mist.plane.position.set(player.x, MIST_Y, player.z);
      }

      info.night = night; info.day = day; info.dusk = dusk; info.fogDensity = fog.density;
      return info;
    },

    dispose() {
      scene.remove(hemi, ambient, sun, sun.target);
      sun.dispose?.();
      if (mist) { scene.remove(mist.plane); mist.plane.geometry.dispose(); mist.mat.dispose(); }
      scene.fog = null;
    },
  };
}
