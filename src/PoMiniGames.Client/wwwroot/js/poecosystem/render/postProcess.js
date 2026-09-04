// postProcess.js — the PoEcosystem composer (GFX options 1, 2 and 6).
//
// Until this existed the game rendered straight to the canvas: no bloom, no shafts, no
// reaction to anything the island did. The chain is
//
//   RenderPass → UnrealBloomPass → AtmospherePass → BokehPass → OutputPass → SMAAPass
//
// and every link past the first is optional, so a low-tier machine still gets the plain
// `renderer.render()` path it had before (see the null facade in createPostProcess).
//
// WHY ONE "ATMOSPHERE" PASS RATHER THAN THREE
// God rays, chromatic aberration, radial blur and the vignette all work from the same
// radial basis (a screen-space vector from the pixel to either the sun or the centre), and
// all four are cheap per tap and expensive per pass. Merged, they cost one full-screen
// draw instead of four and — more importantly — stay coherent: a lightning strike smears,
// fringes and darkens the frame on one curve rather than on three that drift apart.
//
// TONE MAPPING
// three skips the tone-mapping chunk when a material renders into a render target, so the
// whole chain runs in linear HDR and OutputPass applies `renderer.toneMapping` at the end.
// That is the designed flow, and it is why the composer target is HalfFloat: clipping the
// scene to [0,1] before the bloom bright-pass would flatten exactly the highlights bloom
// exists to find.
//
// Importing ../../postFx.js has a side effect worth stating: that module publishes
// `window.PoThreeFx`, which impactFx.js needs to drive its punch envelope. Before this
// file, PoEcosystem never loaded postFx.js, so every app-wide impact preset silently
// no-opped inside this game.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { createRackFocus, punchAberration, punchRadial } from '../../postFx.js';

// Shaft taps per tier. The cost of the atmosphere pass is dominated by this loop, so it is
// the first thing to give way — the aberration/blur/vignette terms are a handful of taps
// and stay on at every tier that runs the pass at all.
const SHAFT_TAPS = { high: 28, medium: 14 };

const ATMOSPHERE_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const atmosphereFrag = (taps) => `
#define SHAFT_TAPS ${taps}
uniform sampler2D tDiffuse;
uniform vec2 uSun;          // sun in screen UV; only read while uShaft > 0
uniform vec3 uShaftTint;
uniform float uShaft;       // 0..1 — visibility x facing x elevation, all decided on the CPU
uniform float uThreshold;   // luminance above which a pixel is treated as a light source
uniform float uAberration;  // radial RGB split at the frame edge, in UV units
uniform float uRadial;      // 0..1 zoom blur
uniform float uVignette;
varying vec2 vUv;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec2 toCentre = vUv - 0.5;
  float r = length(toCentre);

  // Zoom blur first: it defines the base colour the fringe is split from, so a hit that
  // triggers both reads as one smeared image rather than a blur with a sharp ghost in it.
  vec3 col;
  if (uRadial > 0.001) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 6; i++) {
      float t = float(i) / 5.0;
      acc += texture2D(tDiffuse, vUv - toCentre * t * uRadial * 0.06).rgb;
    }
    col = acc * (1.0 / 6.0);
  } else {
    col = texture2D(tDiffuse, vUv).rgb;
  }

  // Chromatic aberration scales with r, so the centre of the frame — where the player is
  // actually looking — stays clean however hard the island is shaking.
  if (uAberration > 0.0001) {
    vec2 off = toCentre * uAberration * r;
    col.r = texture2D(tDiffuse, vUv + off).r;
    col.b = texture2D(tDiffuse, vUv - off).b;
  }

  // Light shafts: march toward the sun accumulating whatever is bright enough to be sky.
  // There is no occlusion buffer — the threshold IS the occlusion test, which is why the
  // terrain (dark, and darker still under its own shadow) silhouettes correctly for free.
  if (uShaft > 0.001) {
    vec2 delta = (vUv - uSun) * (0.92 / float(SHAFT_TAPS));
    vec2 p = vUv;
    float decay = 1.0;
    vec3 shaft = vec3(0.0);
    for (int i = 0; i < SHAFT_TAPS; i++) {
      p -= delta;
      vec3 s = texture2D(tDiffuse, p).rgb;
      shaft += s * smoothstep(uThreshold, uThreshold + 0.4, luma(s)) * decay;
      decay *= 0.955;
    }
    col += shaft * uShaftTint * (uShaft / float(SHAFT_TAPS));
  }

  col *= 1.0 - uVignette * smoothstep(0.34, 0.92, r);
  gl_FragColor = vec4(col, 1.0);
}
`;

function atmosphereShader(taps) {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uSun: { value: new THREE.Vector2(0.5, 0.8) },
      uShaftTint: { value: new THREE.Color(1, 0.94, 0.82) },
      uShaft: { value: 0 },
      uThreshold: { value: 0.55 },
      uAberration: { value: 0 },
      uRadial: { value: 0 },
      uVignette: { value: 0.26 },
    },
    vertexShader: ATMOSPHERE_VERT,
    fragmentShader: atmosphereFrag(taps),
  };
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.PerspectiveCamera} camera
 * @param {{ tier?: string, width?: number, height?: number, pixelRatio?: number }} opts
 * @returns a composer facade; on the low tier, a null facade that draws directly.
 */
export function createPostProcess(renderer, scene, camera, { tier = 'high', width = 1, height = 1, pixelRatio = 1 } = {}) {
  // The null facade exists so renderer.js has exactly one code path. `render()` falling
  // back to a direct draw is the whole of the low-tier story.
  if (tier === 'low') {
    return {
      enabled: false,
      render: () => renderer.render(scene, camera),
      setSize: () => {}, setPixelRatio: () => {}, update: () => {},
      setSun: () => {}, setNight: () => {}, rack: () => {}, dispose: () => {},
    };
  }

  const target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type: THREE.HalfFloatType,
    samples: tier === 'high' ? 4 : 0,     // MSAA in the composer target; SMAA cleans up the rest
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(width, height);

  composer.addPass(new RenderPass(scene, camera));

  // Bloom strength is driven from setNight(): daylight needs almost none (the sky is
  // already the brightest thing on screen, and blooming it just fogs the frame), while at
  // night lava, fire and the selection outline are the only bright pixels and should glow.
  const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.32, 0.72, 0.85);
  composer.addPass(bloom);

  const atmosphere = new ShaderPass(atmosphereShader(SHAFT_TAPS[tier] ?? 14));
  composer.addPass(atmosphere);

  // Transient depth of field. Disabled passes are skipped whole by EffectComposer, so the
  // resting cost really is zero — see postFx.js for why it is never left on.
  const rackFocus = createRackFocus(scene, camera, width, height);
  composer.addPass(rackFocus.pass);

  composer.addPass(new OutputPass());

  // SMAA after OutputPass: edge detection wants display-space luminance, not linear HDR.
  const smaa = tier === 'high' ? new SMAAPass(width, height) : null;
  if (smaa) composer.addPass(smaa);

  const u = atmosphere.uniforms;

  return {
    enabled: true,
    composer,
    bloom,
    render: () => composer.render(),

    /**
     * Per-frame. Folds the shared impact envelope (impactBus, via postFx) into the
     * atmosphere uniforms. The values are recomputed from scratch every frame rather than
     * accumulated, so there is never anything to unwind.
     */
    update(dt) {
      rackFocus.update(dt);
      u.uAberration.value = punchAberration(1);
      u.uRadial.value = punchRadial(0.5);
    },

    /**
     * @param {THREE.Vector2|null} screenUv sun position in UV, or null when it is behind
     *   the camera / off screen — shafts are then skipped rather than marched to a point
     *   that is not there.
     * @param {number} strength 0..1
     * @param {THREE.Color} [tint]
     */
    setSun(screenUv, strength, tint) {
      if (!screenUv || strength <= 0) { u.uShaft.value = 0; return; }
      u.uSun.value.copy(screenUv);
      u.uShaft.value = strength;
      if (tint) u.uShaftTint.value.copy(tint);
    },

    /** dayFraction-driven look: bloom and vignette both lean on the night. */
    setNight(night) {
      const n = Math.max(0, Math.min(1, night));
      bloom.strength = 0.32 + n * 0.5;
      bloom.threshold = 0.85 - n * 0.42;     // at night, far less has to be bright to glow
      u.uVignette.value = 0.22 + n * 0.2;
    },

    /** Rack the focus onto a world distance — the cinematic beat on a big event. */
    rack(distance, hold, strength) { rackFocus.trigger(distance, hold, strength); },

    setSize(w, h) {
      composer.setSize(w, h);
      bloom.setSize(w, h);
      rackFocus.setSize(w, h);
      smaa?.setSize(w, h);
    },
    setPixelRatio(dpr) { composer.setPixelRatio(dpr); },
    dispose() {
      rackFocus.dispose();
      bloom.dispose?.();
      smaa?.dispose?.();
      composer.dispose();
      target.dispose();
    },
  };
}
