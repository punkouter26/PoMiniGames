// sky.js — a sky you can look at, instead of a clear colour.
//
// Until now `scene.background` was a flat colour picked by lighting.js: correct at the
// horizon, wrong everywhere else. Looking up gave the same blue as looking out to sea,
// dusk was an orange wall, and night was a slightly darker wall with no stars in it. On a
// game where the god spends half the time flying, the sky is most of the frame.
//
// Two meshes, both parented to the camera position so they never run out:
//
//   DOME   an inverted sphere with a gradient from zenith to horizon, a sun disc with a
//          soft halo along the sun direction, a moon opposite it, and hash-based stars
//          that fade in with the night factor. Depth-tested off and drawn first, so it is
//          strictly behind everything and costs one full-screen-ish draw.
//   CLOUDS a high plane carrying two octaves of drifting value noise, coverage-thresholded
//          so it reads as separate clouds rather than haze, lit from the sun side and
//          darkened at night. Fades with distance so the plane never shows its edge.
//
// Everything is driven from the same `info` object lighting.update() returns, so the sky,
// the fog, the water and the shafts never disagree about the time of day.
import * as THREE from 'three';

const DOME_RADIUS = 560;
const CLOUD_Y = 96;
const CLOUD_SPAN = 1400;

const NOISE = `
float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x),
             mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const DOME_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  // The dome rides the camera: no translation, so it is a direction field, not a place.
  vec4 clip = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = clip.xyww;   // z = w: always at the far plane, never in front of anything
}
`;

const DOME_FRAG = `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uNight;
uniform float uDusk;
uniform float uTime;
varying vec3 vDir;
${NOISE}

void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);

  // Gradient: the horizon band is wider at dusk, when the warm light sits low.
  float h = pow(1.0 - clamp(up, 0.0, 1.0), mix(2.6, 1.6, uDusk));
  vec3 col = mix(uZenith, uHorizon, h);
  // Below the horizon there is only sea; keep the horizon colour so the dome never shows
  // a seam where the water plane ends.
  col = mix(col, uHorizon * 0.92, smoothstep(0.0, -0.08, up));

  // Sun: a hard disc, a tight halo, and a wide warm glow that carries the dusk.
  float cosSun = dot(d, normalize(uSunDir));
  float disc = smoothstep(0.9993, 0.9997, cosSun);
  float halo = pow(max(cosSun, 0.0), 220.0) * 0.9;
  float glow = pow(max(cosSun, 0.0), 6.0) * (0.22 + uDusk * 0.5);
  col += uSunColor * (disc * 3.0 + halo + glow) * (1.0 - uNight * 0.85);

  // Moon: opposite the sun, small, cool, only at night.
  float cosMoon = dot(d, normalize(-uSunDir + vec3(0.0, 0.35, 0.0)));
  float moon = smoothstep(0.99955, 0.9998, cosMoon) + pow(max(cosMoon, 0.0), 400.0) * 0.35;
  col += vec3(0.86, 0.9, 1.0) * moon * uNight * 1.4;

  // Stars: a hash on a quantised direction, thresholded so only a few cells light, with a
  // slow twinkle. They live above the horizon and only once the sky is dark enough.
  vec2 cell = floor(d.xz / max(abs(d.y), 0.05) * 90.0);
  float s = sHash(cell);
  float star = step(0.986, s) * (0.6 + 0.4 * sin(uTime * (1.5 + s * 3.0) + s * 40.0));
  float aboveHorizon = smoothstep(0.02, 0.2, up);
  col += vec3(0.9, 0.95, 1.0) * star * aboveHorizon * smoothstep(0.35, 0.9, uNight) * 0.9;

  gl_FragColor = vec4(col, 1.0);
}
`;

const CLOUD_VERT = `
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const CLOUD_FRAG = `
uniform vec3 uLit;        // sun-facing colour
uniform vec3 uShade;      // underside colour
uniform vec3 uSunDir;
uniform float uTime;
uniform float uCover;     // 0..1 coverage
uniform float uNight;
varying vec3 vWorld;
${NOISE}

void main() {
  vec2 p = vWorld.xz * 0.006 + vec2(uTime * 0.0045, uTime * 0.0018);
  float n = sNoise(p) * 0.55 + sNoise(p * 2.3 + 7.1) * 0.3 + sNoise(p * 5.1 - 3.3) * 0.15;
  float edge = mix(0.72, 0.42, uCover);
  float body = smoothstep(edge, edge + 0.22, n);
  if (body <= 0.003) discard;

  // Lighting: the sun side of a cloud is where the noise slopes toward the sun. A gradient
  // of the same noise is a cheap normal, and it is enough to give the tops a lit rim.
  float e = 0.02;
  vec2 g = vec2(sNoise(p + vec2(e, 0.0)) - sNoise(p - vec2(e, 0.0)), sNoise(p + vec2(0.0, e)) - sNoise(p - vec2(0.0, e)));
  float lit = clamp(0.5 + dot(normalize(g + 1e-5), normalize(uSunDir.xz + 1e-5)) * 0.6, 0.0, 1.0);
  vec3 col = mix(uShade, uLit, lit) * (1.0 - uNight * 0.75);

  float dist = length(cameraPosition.xz - vWorld.xz);
  float far = 1.0 - smoothstep(380.0, 640.0, dist);
  gl_FragColor = vec4(col, body * 0.86 * far);
}
`;

export function createSky(scene, { tier = 'high' } = {}) {
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(0x3b7dd8) },
      uHorizon: { value: new THREE.Color(0x8ec5ff) },
      uSunColor: { value: new THREE.Color(0xfff2df) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uNight: { value: 0 },
      uDusk: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 18), domeMat);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  dome.name = 'sky';
  scene.add(dome);

  let clouds = null;
  if (tier !== 'low') {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uLit: { value: new THREE.Color(0xffffff) },
        uShade: { value: new THREE.Color(0x9fb3c8) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uTime: { value: 0 },
        uCover: { value: 0.45 },
        uNight: { value: 0 },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const geo = new THREE.PlaneGeometry(CLOUD_SPAN, CLOUD_SPAN, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const plane = new THREE.Mesh(geo, mat);
    plane.position.y = CLOUD_Y;
    plane.renderOrder = -5;
    plane.frustumCulled = false;
    plane.name = 'clouds';
    scene.add(plane);
    clouds = { plane, mat };
  }

  const zenith = new THREE.Color();
  const DAY_ZENITH = new THREE.Color(0x2f6fd0);
  const NIGHT_ZENITH = new THREE.Color(0x0b1326);
  const DUSK_ZENITH = new THREE.Color(0x4a3a7a);

  return {
    dome,
    get clouds() { return clouds?.plane ?? null; },
    /**
     * @param {{ sky: THREE.Color, sunColour: THREE.Color, sunDir: THREE.Vector3, night: number, day: number, dusk: number }} sky
     *   the object lighting.update() returns
     * @param {{x:number, z:number}} player
     * @param {number} time seconds
     */
    update(sky, player, time) {
      const u = domeMat.uniforms;
      zenith.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, sky.day).lerp(DUSK_ZENITH, sky.dusk * 0.6);
      u.uZenith.value.copy(zenith);
      u.uHorizon.value.copy(sky.sky);
      u.uSunColor.value.copy(sky.sunColour);
      u.uSunDir.value.copy(sky.sunDir);
      u.uNight.value = sky.night;
      u.uDusk.value = sky.dusk;
      u.uTime.value = time;
      if (clouds) {
        const c = clouds.mat.uniforms;
        c.uSunDir.value.copy(sky.sunDir);
        c.uTime.value = time;
        c.uNight.value = sky.night;
        // The lit side takes the sun's colour, so dusk clouds go pink without a special case.
        c.uLit.value.copy(sky.sunColour).lerp(new THREE.Color(0xffffff), 0.35);
        c.uShade.value.copy(sky.sky).lerp(new THREE.Color(0x6b7a8c), 0.45);
        clouds.plane.position.set(player.x, CLOUD_Y, player.z);
      }
    },
    dispose() {
      scene.remove(dome); dome.geometry.dispose(); domeMat.dispose();
      if (clouds) { scene.remove(clouds.plane); clouds.plane.geometry.dispose(); clouds.mat.dispose(); }
    },
  };
}
