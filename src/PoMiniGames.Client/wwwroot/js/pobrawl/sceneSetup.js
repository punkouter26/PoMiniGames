// sceneSetup.js — renderer, post chain, environment lighting and the ink edge.
//
// Split out of game.js 2026-09-13, same mixin pattern as vfx.js / cinematics.js
// (see mixin.js for why prototype composition rather than free functions).
//
// What belongs here: the one-time and resize-time construction of the RENDERING
// side — the EffectComposer pass chain, quality-tier application, shadow-map
// sizing, the IBL environment, texture anisotropy, and the Fresnel ink edge.
// None of it reads match state; all of it reads this.renderer / this.scene and
// the quality tier. The fight simulation (_tick, _tickFighting, _tryHit, …)
// stays in game.js, which is the seam this split draws.
//
// ENV_INTENSITY is exported because start() in game.js derives its exposure base
// from it — the constant belongs with the environment code that defines what it
// means, not with the class that happens to also read it.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import * as PostFx from '../postFx.js';
import * as Quality from './quality.js';
import { CAVignetteShader } from './postShader.js';

// ── IBL strength (GFX/SOUND #1) ───────────────────────────────────────────
// scene.environmentIntensity. 0 disables image-based lighting entirely and
// restores the pre-2026-08-09 lights-only look (exposureBase follows it). At
// 0.38 the env is a fill: it puts a reflection in the clearcoat and sheen
// lobes without contributing enough diffuse to lift the shadows, which is the
// specific failure that got the previous env map deleted.
export const ENV_INTENSITY = 0.38;

// ── Ink edge (GFX/SOUND #4) ───────────────────────────────────────────────
// Fresnel-driven edge darkening injected into the fighters' own materials.
//
// WHY NOT AN INVERTED HULL / OutlinePass: both cost a second draw of every
// fighter mesh, every frame — ~40 extra draw calls per fighter on a rig that
// is already the most expensive thing in the scene. And they buy nothing here,
// because this rig is built entirely from capsules and spheres: on smooth
// convex geometry a grazing-angle darkening and an extruded hull resolve to
// visually the same ink line. This one is free — it rides the existing draw.
const INK_BASE = 0.55;      // resting edge strength
const INK_POWER = 2.6;      // Fresnel exponent — higher = tighter line

class SceneSetupMethods {
  // ── setup ───────────────────────────────────────────────────────────────

  // Build (or rebuild) the post chain: MSAA×4 target, GTAO, bloom, CA/vignette.
  _buildComposer(w, h) {
    if (this.composer) {
      // EffectComposer.dispose() only frees its own targets — passes (GTAO's
      // internal buffers, bloom's mip chain) must be disposed explicitly.
      for (const p of this.composer.passes) p.dispose?.();
      try { this.composer.dispose(); } catch { /* already gone */ }
    }
    this.bloomPass = null;
    this.fxPass = null;
    this.afterimage = null;
    // Disposed above with the rest of the passes; drop the handle so a stale
    // one cannot be updated against the new composer.
    this.rackFocus = null;

    const q = Quality.settings();
    const pixelRatio = Quality.pixelRatio(w, h);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h);
    // Remembered so _applyQuality can tell a samples change (needs a rebuild —
    // it is a render-target property) from a change it can apply in place.
    this._composerSamples = q.msaaSamples;

    // Bloom threshold sits just under the spark/hit-flash luminance so
    // impacts glow while the arena itself stays clean.
    // MSAA render target — the composer's default target has no samples,
    // which would drop the AA the raw canvas had. Sample count is tiered:
    // 4 → 2 → 0, and at 0 the target is a plain non-multisampled one.
    const composerRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: q.msaaSamples,
    });
    this.composer = new EffectComposer(this.renderer, composerRT);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Ground-truth AO: contact-level darkening in armpits, under ropes and
    // between crowd rows that flat hemisphere ambient destroys.
    //
    // Also the most expensive pass in the chain by a wide margin — a depth+normal
    // prepass, a multi-sample AO pass and a denoise, every frame at full res. It
    // ran unconditionally on every machine; now it is 'high' tier only, and even
    // there at half the stock sample count.
    this.gtaoPass = null;
    try {
      const gtao = new GTAOPass(this.scene, this.camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 0.85;
      // The AO term here is a broad contact darkening, not a detail feature, so
      // halving the sample count is not visible at this camera distance. Guarded
      // because the parameter name is three-version-specific and a missing one
      // must not cost us the pass.
      try { gtao.updateGtaoMaterial({ samples: q.gtaoSamples }); } catch { /* stock samples */ }
      gtao.enabled = q.gtao;
      this.gtaoPass = gtao;
      this.composer.addPass(gtao);
    } catch { /* AO is a nicety — never block the game on it */ }
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.32, 0.55, 0.8);
    // UnrealBloom allocates a five-level mip chain at the composer's resolution and
    // does two blur passes per level. EffectComposer skips a disabled pass entirely,
    // so dropping it at 'low' is a genuine saving rather than a no-op.
    this.bloomPass.enabled = q.bloom;
    this.composer.addPass(this.bloomPass);
    // ── Afterimage / velocity smear (GFX/SOUND #9) ─────────────────────
    // Frame-feedback trails for dashes, launches and the super. Placed after
    // bloom so the trail carries the glow with it — a smear of the pre-bloom
    // frame reads as a dirty buffer, not as speed.
    //
    // WHY A FULL-SCREEN PASS RATHER THAN GHOST COPIES OF THE RIG: the classic
    // implementation clones the skeleton three or four times and draws it with
    // a fading additive material, which is 40-odd extra draw calls per ghost on
    // the heaviest object in the scene. Feedback costs one fullscreen quad and
    // produces a continuous trail instead of discrete stamps. It also cannot
    // smear the static arena: a pixel that did not change blends with itself.
    //
    // DISABLED by default. EffectComposer skips a disabled pass entirely, so
    // the off state is genuinely free — this only runs during the fraction of a
    // second something is actually moving fast enough to warrant it.
    this.afterimage = new AfterimagePass(0.0);
    this.afterimage.enabled = false;
    this.composer.addPass(this.afterimage);
    // §GFX-2 rack focus. Disabled during the fight and enabled for the KO, when
    // the action has already stopped — see postFx.js for why a permanent DoF
    // pass is not affordable here (it doubles the scene's draw calls).
    // Deliberately AFTER bloom: blurring an already-bloomed frame keeps the
    // highlights blooming and then throws them out of focus together, which is
    // what a real lens does. Before bloom, the bloom would re-sharpen them.
    this.rackFocus = PostFx.createRackFocus(this.scene, this.camera, w, h);
    this.composer.addPass(this.rackFocus.pass);
    this.fxPass = new ShaderPass(CAVignetteShader);
    this.composer.addPass(this.fxPass);
    this.composer.addPass(new OutputPass());
  }

  /**
   * Re-apply the adaptive-quality tier to the live renderer.
   *
   * Called once at boot and again on every `po-gfx-tier` event. Everything touched
   * here is cheap to change on a running renderer; the one setting that is NOT
   * (scene light count, a shader #define) is fixed at boot in start(). See
   * quality.js for the full static/dynamic split and the reasoning behind it.
   */
  _applyQuality() {
    const q = Quality.settings();
    const cw = this.container.clientWidth || 800;
    const ch = this.container.clientHeight || 540;

    // ── Resolution ────────────────────────────────────────────────────────
    const dpr = Quality.pixelRatio(cw, ch);
    if (this.renderer.getPixelRatio() !== dpr) {
      this.renderer.setPixelRatio(dpr);
      this.composer?.setPixelRatio(dpr);
      this.composer?.setSize(cw, ch);
      this.rackFocus?.setSize(cw, ch);
    }

    // ── Post chain ────────────────────────────────────────────────────────
    // `enabled` is all that is needed: EffectComposer skips a disabled pass, so
    // these cost nothing in the off state and need no rebuild to toggle.
    if (this.gtaoPass) this.gtaoPass.enabled = q.gtao;
    if (this.bloomPass) this.bloomPass.enabled = q.bloom;

    // MSAA sample count is a property of the composer's render target, so it is
    // the one post-chain setting that does need a rebuild. Only when it moves —
    // _buildComposer reallocates every target and re-runs GTAO's setup.
    if (this.composer && this._composerSamples !== q.msaaSamples) {
      this._buildComposer(cw, ch);
    }

    // ── Shadows ───────────────────────────────────────────────────────────
    // mapSize changes no #define, so this reallocates a depth target without
    // recompiling anything. The old map must be disposed explicitly — three
    // allocates a new one lazily on the next render but never frees the old.
    const L = this.arena?.lights;
    if (L) {
      this._setShadowSize(L.key, q.keyShadow);
      // spotShadow 0 means "stop casting entirely", which removes a whole second
      // shadow render pass rather than merely shrinking it.
      if (q.spotShadow > 0) {
        L.spot.castShadow = true;
        this._setShadowSize(L.spot, q.spotShadow);
      } else if (L.spot.castShadow) {
        L.spot.castShadow = false;
        L.spot.shadow.map?.dispose();
        L.spot.shadow.map = null;
      }
    }
  }

  /** Resize one light's shadow map, disposing the old target so it isn't leaked. */
  _setShadowSize(light, size) {
    if (!light || light.shadow.mapSize.width === size) return;
    light.shadow.mapSize.set(size, size);
    light.shadow.map?.dispose();
    light.shadow.map = null;
    light.shadow.needsUpdate = true;
  }

  // ── Ink edge (GFX/SOUND #4) ────────────────────────────────────────────
  // Injects a Fresnel edge-darkening term into every material on one fighter
  // rig, so the caricature reads as a drawn figure against the photoreal-ish
  // hall instead of dissolving into it. Returns the uniform objects so the
  // super cinematic can drive them.
  //
  // The injection point is `opaque_fragment` — after all lighting, before tone
  // mapping. That ordering is load-bearing: the composer renders into a
  // HalfFloat target, so three compiles these materials with NoToneMapping and
  // OutputPass tone-maps at the end. Darkening before the curve means the line
  // survives AgX's shoulder instead of being rolled flat by it.
  _applyInkEdge(rig) {
    if (INK_BASE <= 0) return [];
    const uniforms = [];
    const seen = new Set();
    rig.root.traverse((obj) => {
      const mats = obj.material
        ? (Array.isArray(obj.material) ? obj.material : [obj.material])
        : [];
      for (const m of mats) {
        // Materials are shared across meshes within a rig (one suitMat dresses
        // a dozen parts), and compiling the same program twice with two
        // different uniform objects would leave half the rig on a stale one.
        if (!m || seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        // Basic materials (blob shadows, trails) have no `normal` in scope and
        // no lighting to darken — the chunk replace below would fail to match
        // and silently do nothing, so skip them explicitly.
        if (!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial) continue;

        const u = {
          uInk: { value: INK_BASE },
          uInkPower: { value: INK_POWER },
          // Near-black navy rather than pure black: a true 0,0,0 line reads as
          // a hole punched in the frame once bloom lights up around it.
          uInkColor: { value: new THREE.Color(0x05070f) },
          // #3 — flat-fill amount. Driven to 1 for the two frames of an impact
          // frame, which blows the fighter out to a solid silhouette.
          //
          // This is why the anime impact frame costs nothing: the obvious
          // implementation re-renders the rigs with an override material into a
          // second target, which is a whole extra draw of the most expensive
          // objects in the scene. Folding it into a uniform the fighters'
          // materials already carry makes the silhouette a branch in a shader
          // that was going to run anyway — and it masks perfectly, because only
          // the fighters have this injection at all.
        };
        m.onBeforeCompile = (shader) => {
          shader.uniforms.uInk = u.uInk;
          shader.uniforms.uInkPower = u.uInkPower;
          shader.uniforms.uInkColor = u.uInkColor;
          shader.fragmentShader = shader.fragmentShader
            .replace('void main() {', /* glsl */`
              uniform float uInk;
              uniform float uInkPower;
              uniform vec3 uInkColor;
              void main() {`)
            .replace('#include <opaque_fragment>', /* glsl */`
              #include <opaque_fragment>
              {
                // vViewPosition is fragment→camera in view space; \`normal\` is
                // the shaded view-space normal (post normal-map). Their dot
                // falling toward 0 IS the silhouette.
                float _facing = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
                float _ink = pow(1.0 - _facing, uInkPower) * uInk;
                gl_FragColor.rgb = mix(gl_FragColor.rgb, uInkColor, clamp(_ink, 0.0, 1.0));
                // The flat-white impact fill that used to close this block is
                // gone (2026-09-12) — see _impactFrame in vfx.js for why.
              }`);
        };
        // Materials are cached by program key; two rigs whose materials differ
        // only in uniform VALUES share a program, which is what we want. Bump
        // needsUpdate so the injection is picked up on this material's first
        // compile rather than whenever something else happens to dirty it.
        m.needsUpdate = true;
        uniforms.push(u);
      }
    });
    return uniforms;
  }

  // ── Image-based lighting (GFX/SOUND #1) ────────────────────────────────
  // Paints a 512×256 equirectangular canvas of THIS arena and runs it through
  // PMREMGenerator to get the prefiltered mip chain a PBR roughness lobe needs.
  //
  // A painted equirect rather than a rendered cubemap of the real scene: the
  // scene is rebuilt every round and a live cubemap would have to be re-rendered
  // with it (six faces plus prefiltering), for reflections nobody can resolve on
  // a capsule. The layout below is a deliberate caricature of the room — the
  // things a fighter's shoulder actually catches, in the directions it catches
  // them from.
  _buildEnvironment() {
    if (ENV_INTENSITY <= 0) return;
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d');

    // Vertical base: dark hall at the horizon, a touch of cool lift toward the
    // ceiling, and the canvas bouncing blue-violet up from below. v=0 is +Y
    // (up) in three's equirect convention, v=1 is −Y (down).
    const sky = g.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0.00, '#39406e');   // ceiling / truss haze
    sky.addColorStop(0.42, '#161a2e');   // the dark upper hall
    sky.addColorStop(0.58, '#121526');   // horizon — darkest band
    sky.addColorStop(1.00, '#3d4680');   // ring canvas bounce (matches arena.js)
    g.fillStyle = sky;
    g.fillRect(0, 0, 512, 256);

    // The overhead house light: one hot warm pool near the top. This is the
    // highlight that will actually appear in a clearcoat lobe, so it is the
    // single most important thing on this canvas.
    const pool = g.createRadialGradient(256, 26, 4, 256, 26, 120);
    pool.addColorStop(0, 'rgba(255, 246, 222, 1)');
    pool.addColorStop(0.35, 'rgba(255, 232, 186, 0.5)');
    pool.addColorStop(1, 'rgba(255, 232, 186, 0)');
    g.fillStyle = pool;
    g.fillRect(0, 0, 512, 160);

    // Rig lenses along the truss — a row of small warm/cool sources that give
    // a moving fighter a sequence of highlights rather than one static blob.
    const lens = ['#fff2d0', '#bcd0ff', '#fff2d0', '#ffd0d0'];
    for (let i = 0; i < 8; i++) {
      const x = 32 + i * 64;
      const lg = g.createRadialGradient(x, 58, 2, x, 58, 34);
      lg.addColorStop(0, lens[i % lens.length]);
      lg.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = 0.5;
      g.fillStyle = lg;
      g.fillRect(x - 34, 24, 68, 68);
    }
    g.globalAlpha = 1;

    // Corner accents at the horizon: the red and blue corner lights, 180° apart
    // so a fighter turning between them picks up opposing warm/cool rims.
    for (const [x, col] of [[96, 'rgba(255, 92, 92, 0.55)'], [352, 'rgba(96, 140, 255, 0.55)']]) {
      const cg = g.createRadialGradient(x, 148, 3, x, 148, 90);
      cg.addColorStop(0, col);
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = cg;
      g.fillRect(x - 90, 58, 180, 180);
    }

    // Crowd band: a dim speckled ring at eye level. Contributes almost no light
    // but breaks the horizon up, so a polished shoe reflects a textured hall
    // instead of a flat grey stripe.
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * 512;
      const y = 132 + Math.random() * 34;
      g.fillStyle = `rgba(${120 + Math.random() * 60 | 0}, ${130 + Math.random() * 60 | 0}, 190, ${0.05 + Math.random() * 0.13})`;
      g.fillRect(x, y, 3 + Math.random() * 5, 2 + Math.random() * 3);
    }

    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    // fromEquirectangular hands back a render target we own; keep the handle so
    // dispose() can release it. A scene.traverse() walk cannot reach it — the
    // same class of leak disposeArenaReflector exists to document.
    this._envRT = pmrem.fromEquirectangular(tex);
    this.scene.environment = this._envRT.texture;
    this.scene.environmentIntensity = ENV_INTENSITY;
    // The source canvas texture and the generator have both done their job the
    // moment the mip chain exists.
    tex.dispose();
    pmrem.dispose();
  }

  // Anisotropic filtering for every texture in the scene. The ring mat is a
  // large plane seen at a grazing angle — the single most anisotropy-sensitive
  // surface here — and at 1x its scuff/wear detail smears to mush toward the
  // far edge. Costs nothing but sampler state.
  _applyTextureAnisotropy() {
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    if (!maxAniso || maxAniso <= 1) return;
    const aniso = Math.min(maxAniso, 8); // 8 is where the returns flatten
    const seen = new Set();
    const MAPS = ['map', 'roughnessMap', 'normalMap', 'bumpMap', 'aoMap',
                  'metalnessMap', 'emissiveMap', 'alphaMap'];
    this.scene.traverse((o) => {
      if (!o.isMesh && !o.isPoints) return;
      for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!mat) continue;
        for (const slot of MAPS) {
          const tex = mat[slot];
          if (!tex || seen.has(tex.uuid) || tex.anisotropy === aniso) continue;
          seen.add(tex.uuid);
          tex.anisotropy = aniso;
          tex.needsUpdate = true;
        }
      }
    });
  }
}

export const SceneSetup = SceneSetupMethods.prototype;
