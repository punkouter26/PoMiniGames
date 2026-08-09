// game.js — PoBrawl match orchestrator.
// Owns: scene, camera, fixed-timestep sim, per-fighter state machine, momentum +
// per-region damage + hit-pause + screen shake + cinematic camera + replay buffer,
// audio bus, and the Blazor interop callbacks.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { buildArena, animateCrowd, updateAtmosphere, updateRopes, updateBanners, twangRope, damagePost, disposeArenaReflector, RING_HALF } from './arena.js';
import { buildProps, resetProps, updateProps, disposeProps } from './props.js';
import { buildFighter, updateJiggles, setExpression, CHARACTERS, CHARACTER_IDS } from './fighters.js';
import { Animator } from './animation.js';
import { KeyboardController } from './input.js';
import { AiController } from './ai.js';
import { RandomGenerator } from './rng.js';
import { CombatPlay, COMBAT_EVENTS, REGIONS, regionEffect } from './combat.js';
import { PERSONALITIES, makePersonalityState } from './personalities.js';
import * as PostFx from '../postFx.js';
import { AudioBus } from './audio.js';
import { ReplayBuffer } from './replay.js';
import { CannonRagdoll, SeveredArm } from './ragdoll-physics.js';
import { testAttackHit, testAttackBlocked, regionForHurtBone } from './hitboxes.js';
import {
  createPhysicsWorld, stepWorld, buildArenaColliders,
  buildFighterPhysics, syncHurtSpheres, syncRigRoot,
  buildSwingPhysics, syncStrikerSpheres, destroySwingPhysics,
  applyRecoil, G_HURT, G_STRIKER,
} from './physics.js';

const SIM_DT = 1 / 60;
const MAX_FRAME_DT = 0.05;
const MAX_HP = 100;
const TIME_LIMIT = 99;

// ── Spawn X by HUD side ────────────────────────────────────────────────────
// Each fighter spawns at the X that lines up with the side their energy bar
// is drawn on by the Blazor HUD:
//   • index 1 → HUD `.pb-hp-side` (no right class) → renders on the LEFT
//   • index 2 → HUD `.pb-hp-side.pb-hp-right`     → renders on the RIGHT
// The world-space spawn X mirrors that screen side: negative X projects to
// the left of the camera (which sits at +Z looking toward −Z), positive X
// projects to the right. Single source of truth — change here, not in
// `_spawnFighters`, so the spawn and the HUD can never desync.
const SPAWN_X_BY_SIDE = { left: -1.6, right: 1.6 };

// ── Overhead house light swing ────────────────────────────────────────────
// The ring spotlight (arena.js `lights.spot`) sweeps a wide elongated
// ellipse over the ring (mostly along Z, with a smaller X amplitude and a
// pronounced vertical bob), aimed down at the midpoint between the fighters.
// The pool of light, the cast shadows and the volumetric shaft therefore all
// sweep visibly back and forth across the canvas — the rig lamp is no longer
// nailed above the centre, it swings like a hanging studio fixture. See the
// "Room light swing" block in _updateLighting.
const HOUSE_LIGHT_RADIUS = 4.4;              // wide Z swing (was 2.6)
const HOUSE_LIGHT_RADIUS_X = 1.6;            // narrower X swing for an ellipse, not a circle
const HOUSE_LIGHT_BOB = 1.8;                 // vertical bobbing amplitude
const HOUSE_LIGHT_HEIGHT = 11;
const HOUSE_LIGHT_SPEED = (Math.PI * 2) / 12; // rad/s — one lap per ~12 s (was 26)

const MIN_SEPARATION = 0.95;

// Frame-data table. cancelInto = minimum stateT to transition into each named
// state. { idle: 0 } means recovery auto-completes when stateT reaches the end.
// Damage tuned to 10/15 (was 40/60) so matches last ~4x longer — roughly
// 25-40 exchanges. The damage-derived FEEL scalars (stagger threshold,
// reaction power, audio power) are rescaled to match so hits still land hard.
// `reach` reflects the REAL polygon contact range now: the striker capsules
// ride the actual fist/shoe meshes (see hitboxes.js), so root-to-root hit
// distance ≈ limb extension + lunge. The old values assumed a half-meter of
// invisible forward reach.
const ATTACKS = {
  punch: { name: 'punch', windup: 0.08, active: 0.10, recover: 0.22, dmg: 10, reach: 1.2,
           cancelInto: { idle: 0.30, punch: 0.20, kick: 0.26, block: 0.32 } },
  kick:  { name: 'kick',  windup: 0.12, active: 0.12, recover: 0.30, dmg: 15, reach: 1.45,
           cancelInto: { idle: 0.42, punch: 0.34, kick: 0.36, block: 0.40 } },
};

const HITSTUN = 0.35;

// ── Dismemberment ─────────────────────────────────────────────────────────
// When the arms region reddens, an arm tears off and falls to the canvas with a
// silly blood squirt. The non-punching (LEFT) arm goes first (>= ARM_SEVER_L)
// so the fighter keeps its striking arm — with one arm you can only punch with
// that (right) arm. The right/striking arm only tears off once the left is
// already gone and damage is near-max (ARM_SEVER_R); after that the fighter has
// no arms and can only kick.
const ARM_SEVER_L = 50;
const ARM_SEVER_R = 78;
// (Severed limbs are simulated by cannon now — see SeveredArm in
// ragdoll-physics.js — so the hand-rolled tumble/ground constants that used to
// live here are gone. The canvas plane and the ragdoll contact material own
// clearance, bounce and damping.)

// How much harder a CHARGED "power" hit chews the struck limb vs a tap. Region
// (limb) damage is what reddens the body-diagram section and eventually tears an
// arm off; a full-charge blow adds this multiple of extra region damage on top
// of the base so a couple of power shots to one arm sever it before the KO. The
// bonus scales with charge (0 at a tap, full at max charge) — see the region
// damage line in _resolveHit. Without it, region damage tracked HP too closely
// and the match always ended before any single limb reddened enough (the
// symptom the demo showed: limbs never fell off).
const REGION_CHARGE_BONUS = 1.8;
// A charged power blow that lands elsewhere still rattles the defender's
// guarding arms — this fraction of the hit bleeds into the arms region so a
// sustained power beating reddens and eventually tears an arm off even without
// clean arm hits (which are geometrically rare: a straight strike lands on the
// torso/head, not the arms hanging at the sides). Scales with charge; a tap
// does nothing. Without this, arms plateaued after the odd incidental hit and a
// limb never came off in a full CPU-vs-CPU demo.
const ARM_SPLASH_FRAC = 0.7;

// ── Hold-to-charge (Urban Champion style) ────────────────────────────────
// Press-and-hold punch/kick winds the attack up; release throws it. Charge
// scales damage/knockback 1x → CHARGE_MAX_MUL over CHARGE_TIME seconds of
// hold; the fighter is rooted while charging and can hold at max forever
// (at the cost of eating anything the opponent throws — a hit drops the
// stored charge).
const CHARGE_TIME = 1.0;
const CHARGE_MAX_MUL = 2.0;

// ── Energy meter ─────────────────────────────────────────────────────────
// One 0..1 pool per fighter, shown under the HP bar in the Blazor HUD. It IS
// the stored attack power: a release spends ALL of it (chargeMul 1x when
// empty → CHARGE_MAX_MUL when full). ONLY two things move the bar: winding up
// a punch/kick (the charge state) fills it toward the peak, and releasing the
// attack empties it to zero. Every fighter starts each match banked at 1/3 —
// there is no idle regen, no block reward, and taking a hit doesn't touch it.
const ENERGY_DEFAULT = 1 / 3;

// Fighters never leave their feet before the final blow — heavy hits get a
// hard stagger (extra knockback + lean) instead of a mid-fight knockdown.
// The KO ragdoll is the only way to the canvas.
const HEAVY_HIT_DMG = 13; // threshold for the amplified stagger reaction (¼ of the old 50, matching the ¼ damage table)

// ── Post-processing: CA + vignette + radial blur + broadcast grade ───────
// Runs after bloom, before OutputPass (so it operates on the linear HDR
// frame). uCA and uRadial are pulsed by hits and the KO flash; uDesat rides
// the KO lights-down blend (drains color, keeps the reds); the teal-shadow /
// warm-highlight grade and vignette are constant.
const CAVignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    uCA: { value: 0 },
    uVignette: { value: 0.5 },
    uRadial: { value: 0 },
    uGrade: { value: 1.0 },
    uDesat: { value: 0 },
    // Film grain (idea #10): animated luminance-weighted noise. uGrain is the
    // amount (0 = off); uTime drives the per-frame hash so the grain crawls.
    //
    // 2026-08-07 (user request): OFF. At 0.04 the noise was weighted into the
    // shadows, and PoBrawl's fighters are mostly dark suits against a dark
    // hall — so instead of reading as film texture it read as a crawling
    // cross-hatch woven over the whole image, which is what it looked like on
    // the KO frames. The shader branch below is skipped entirely at 0, so this
    // costs nothing; raise it if the look is ever wanted back.
    uGrain: { value: 0.0 },
    uTime: { value: 0 },
    // ── Godrays / lens-flare uniforms (idea #10) ───────────────────
    // uGodrays     : intensity (0 = off). Drives the spotlight blade.
    // uGodraysOrig : screen-space origin of the shaft in UV (default 0.5,1.05 — top edge).
    // uGodraysDecay: per-step exponential falloff for the marching sample.
    // uGodraysTint : godray tint (warm yellow during KO).
    uGodrays: { value: 0 },
    uGodraysOrig: { value: [0.5, 1.05] },
    uGodraysDecay: { value: 0.94 },
    uGodraysTint: { value: [1.0, 0.94, 0.78] },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uCA;
    uniform float uVignette;
    uniform float uRadial;
    uniform float uGrade;
    uniform float uDesat;
    uniform float uGodrays;
    uniform vec2 uGodraysOrig;
    uniform float uGodraysDecay;
    uniform vec3 uGodraysTint;
    uniform float uGrain;
    uniform float uTime;
    varying vec2 vUv;
    // Cheap hash for the film grain — no texture fetch.
    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    void main() {
      vec2 off = (vUv - 0.5) * uCA * 0.012;
      float r = texture2D(tDiffuse, vUv + off).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - off).b;
      vec3 col = vec3(r, g, b);

      // Radial impact blur: a short streak toward the frame center. 4 extra
      // taps is enough at pulse strengths — it reads as a punch, not a filter.
      if (uRadial > 0.003) {
        vec2 dir = (vec2(0.5) - vUv) * uRadial * 0.05;
        vec3 acc = col;
        acc += texture2D(tDiffuse, vUv + dir * 1.0).rgb;
        acc += texture2D(tDiffuse, vUv + dir * 2.0).rgb;
        acc += texture2D(tDiffuse, vUv + dir * 3.0).rgb;
        acc += texture2D(tDiffuse, vUv + dir * 4.0).rgb;
        col = acc * 0.2;
      }

      // Godrays: sample along a line from each pixel toward the spotlight origin
      // (projected to screen space by the JS side). Each tap decays by
      // uGodraysDecay, so bright pixels near the origin smear outward as
      // the blade of light. 16 taps is cheap and reads as proper cinema.
      if (uGodrays > 0.003) {
        const int STEPS = 16;
        vec2 dir = (uGodraysOrig - vUv) / float(STEPS);
        float weight = 0.0;
        vec3 acc = vec3(0.0);
        float w = 1.0;
        vec2 p = vUv;
        for (int i = 0; i < STEPS; i++) {
          p += dir;
          vec3 s = texture2D(tDiffuse, p).rgb;
          // Threshold the sample so the lit pixels (spotlight + ring trim)
          // contribute most; the dim arena walls contribute little.
          float l = max(max(s.r, s.g), s.b);
          float mask = smoothstep(0.78, 1.05, l);
          acc += s * w * mask;
          weight += w * mask;
          w *= uGodraysDecay;
        }
        if (weight > 0.0001) {
          vec3 blade = acc / weight;
          col += blade * uGodrays * uGodraysTint;
        }
      }

      // Broadcast grade: teal-pushed shadows, warm highlights, +saturation.
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += vec3(0.008, 0.02, 0.038) * (1.0 - smoothstep(0.0, 0.4, lum)) * uGrade;
      col *= mix(vec3(1.0), vec3(1.05, 1.0, 0.93), smoothstep(0.3, 1.0, lum) * uGrade);
      col = mix(vec3(lum), col, 1.0 + 0.1 * uGrade);
      // Filmic S-curve contrast: crush the toe a touch and roll the shoulder so
      // the grade reads like a graded LUT rather than a flat colour shift. Only
      // the amount is dialled by uGrade — the shape is fixed.
      vec3 sc = col * col * (3.0 - 2.0 * col);   // smoothstep-shaped contrast
      col = mix(col, sc, 0.18 * uGrade);

      // KO drain: desaturate except strong reds (blood-red trim, red corner).
      if (uDesat > 0.003) {
        float keepRed = smoothstep(0.1, 0.4, col.r - max(col.g, col.b));
        vec3 drained = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, keepRed);
        col = mix(col, drained, uDesat);
      }

      float d = distance(vUv, vec2(0.5));
      col *= 1.0 - smoothstep(0.55, 0.95, d) * uVignette;

      // Film grain (idea #10): animated monochrome noise, strongest in the
      // shadows (where sensor noise actually lives) and fading out of the
      // highlights so bright speculars stay clean. Two hashed samples offset
      // by the frame time keep it crawling rather than static-dithering.
      if (uGrain > 0.0001) {
        float g1 = hash21(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 71.7);
        float grain = (g1 - 0.5);
        float shadowW = 1.0 - smoothstep(0.0, 0.55, lum); // more grain in darks
        col += grain * uGrain * (0.35 + 0.65 * shadowW);
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// Scratch vector for the blob-shadow tracker.
const _blobPos = new THREE.Vector3();
// Scratch vectors for sweat spray and strike-trail sampling.
const _sweatPos = new THREE.Vector3();
const _trailPos = new THREE.Vector3();
// Scratch vectors for contact-impulse resolution.
const _leverArm = new THREE.Vector3();
const _impLocal = new THREE.Vector3();
// Scratch vector for the overhead KO face shot (tracks the ragdoll head).
const _koHead = new THREE.Vector3();
// Scratch vectors for the lighting updater.
const _spotTarget = new THREE.Vector3();
const _blDir = new THREE.Vector3();
const _beamDir = new THREE.Vector3();
const _upY = new THREE.Vector3(0, 1, 0);
// Scratch vectors for posture (look-at / momentum) updates.
const _animVel = new THREE.Vector3();
const _lookA = new THREE.Vector3();
const _lookB = new THREE.Vector3();

export class BrawlGame {
  constructor(container, dotnetRef, options) {
    this.container = container;
    this.dotnet = dotnetRef;
    this.options = options;
    this.muted = false;
    this.disposed = false;
    this.raf = 0;
    this.accumulator = 0;
    this.lastFrame = 0;
    this.timeScale = 1;
    // Effects list — sparks, debris, post chunks. Updated each render tick.
    this.effects = [];
    // Renderer-level feedback: hit-pause, screen shake, FOV punch.
    this.hitstopT = 0;
    this.shakeT = 0;
    this.shakeAmp = 0;
    this.fovPunch = 0;
    this.fovBase = 55;
    // Post-FX pulses: bloom strength, chromatic aberration, radial blur and
    // exposure spike on hits and KO, then decay exponentially in _updateFx.
    this.caPulse = 0;
    this.bloomPulse = 0;
    this.exposurePulse = 0;
    this.radialPulse = 0;
    // Clash (striker-vs-striker) debounce.
    this._clashCooldown = 0;
    // Spring-damper camera state (see _updateCamera).
    this._camVel = new THREE.Vector3();
    // KO "lights down" blend (0 = house lights, 1 = spotlight-only).
    this.lightsDim = 0;
    // Atmosphere clock — always advances (this.clock only runs while fighting).
    this.atmoT = 0;
    // Cinematic state: KO zoom + replay buffer.
    this.cameraMode = 'normal'; // 'normal' | 'ko' | 'replay'
    this.cameraModeT = 0;
    this.koShot = 'side'; // per-KO camera variant: 'side' | 'overhead'
    this.replayT = 0;
    this.excited = 0; // crowd excitement
    this.audio = new AudioBus();
    this.replay = new ReplayBuffer();
    // Seeded RNG so a demo/kiosk replay is reproducible.
    this.rng = new RandomGenerator((options && options.seed) || 1337);
    // GFX quality is pinned to the maximum tier (MSAA×4 + GTAO + bloom + CA).
    // The auto-stepdown and the on-screen "FX" tier badge were removed per user
    // request — the game always renders at full quality regardless of framerate.
  }

  start() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 540;

    // antialias:false is deliberate. Every frame is rendered into the
    // composer's own MSAA target (see _buildComposer) and reaches the canvas
    // as a fullscreen quad in OutputPass — a quad has no interior edges, so a
    // multisampled default framebuffer would be allocated and never resolved
    // against any geometry. The `samples` on composerRT is the real AA.
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(window.PoCanvasDpr.ceiling());   // audit #8: shared policy, js/canvasDpr.js
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    // PCFSoft: percentage-closer soft edges — the fighters' shadows get a
    // real penumbra instead of the stepped PCF look.
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // AgX handles saturated bright lights (bloom pulses, colored corner
    // accents) far more gracefully than ACES, which skews hot colors.
    // Measured against ACES/Neutral/Reinhard on a live frame: AgX keeps ~15%
    // of pixels in the midtones where the others crush 95-98% into shadow.
    this.renderer.toneMapping = THREE.AgXToneMapping;
    // Contrast comes from the lighting ratio (key vs hemisphere fill), NOT from
    // exposure — exposure lifts shadows and highlights together, so pushing it
    // just makes a flat image a brighter flat image. Measured: at 1.9 the frame
    // went 99.8% midtones with 0% shadows, visibly worse than 1.15. The real
    // lever is the hemisphere cut + hotter key in arena.js; exposure only takes
    // the small step needed to keep overall level after that cut.
    //
    // Bumped 1.3 → 1.5 to compensate for the removed IBL fill — without the
    // env map the rig now has to carry the full ambient level on its own, and
    // exposure is the simplest way to keep the ring reading bright without
    // flattening contrast (the hemisphere is still cut hard below).
    this.exposureBase = 1.5;
    this.renderer.toneMappingExposure = this.exposureBase;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Reflection effects removed entirely per user request — no IBL, no
    // scene.environment, no PMREM/RoomEnvironment generation. The real
    // key/rim/spot/RectArea-panel rig plus the brighter house lights carry
    // all of the scene's illumination now, so the ring reads bright without
    // the softbox speculars that a PBR env map would lay on top.
    this.arena = buildArena(this.scene);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 100);
    this.camera.position.set(0, 2.4, 7);

    // Post chain: render → GTAO → bloom → CA/vignette → tone-map/sRGB
    // output (see _buildComposer).
    this._buildComposer(w, h);

    // GPU particle pool: one THREE.Points draw call for every spark, sweat
    // droplet and confetti fleck (the old system built a SphereGeometry mesh
    // per spark). Additive blending means "fade" is just color → black, so
    // no per-particle alpha attribute is needed.
    this._initParticles();

    // Impact light pool: reused PointLights flashed at hit points. A fixed
    // pool keeps the scene's light count constant (adding/removing lights at
    // runtime forces shader recompiles).
    this._impactLights = Array.from({ length: 3 }, () => {
      const light = new THREE.PointLight(0xffa050, 0, 5, 2);
      this.scene.add(light);
      return { light, life: 0, dur: 0.15, peak: 0 };
    });
    this._impactCursor = 0;

    // Per-fighter backlights: cool kicker spots behind each fighter, opposite
    // the camera — constant halo separation from the dark background.
    // Repositioned every frame in _updateLighting.
    this._backlights = [0, 1].map(() => {
      const s = new THREE.SpotLight(0x7d95ff, 3.0, 14, Math.PI / 5, 0.85, 1.6);
      s.castShadow = false;
      this.scene.add(s);
      this.scene.add(s.target);
      return s;
    });

    // ── KO Limelight: tight, narrow SpotLight that tracks the ragdoll ──
    // Used during the KO cinematic to follow the falling body and offer
    // that "single bright slash of light over the loser" feel. Intensity
    // starts at 0; spikes to ~6.0 on a KO event and tracks the loser's
    // torso each frame while d > 0.
    this._limelight = new THREE.SpotLight(0xfff0d0, 0, 9, Math.PI / 9, 0.7, 1.0);
    this._limelight.castShadow = false;
    this.scene.add(this._limelight);
    this.scene.add(this._limelight.target);
    this._limelightActive = 0; // 0 = idle, >0 = active timeleft
    this._limelightTarget = new THREE.Vector3();

    // Companion cool "victor halo" — opposite-side kicker that follows the
    // WINNER while the loser has the warm limelight. Together they light
    // both fighters from different angles during the KO cinematic.
    this._victorHalo = new THREE.SpotLight(0xa0c4ff, 0, 12, Math.PI / 6, 0.7, 1.2);
    this._victorHalo.castShadow = false;
    this.scene.add(this._victorHalo);
    this.scene.add(this._victorHalo.target);

    this.banner = document.createElement('div');
    this.banner.className = 'pb-banner';
    this.container.appendChild(this.banner);

    // CSS overlay for chromatic aberration / vignette flash on KO.
    this.flash = document.createElement('div');
    this.flash.className = 'pb-flash';
    this.container.appendChild(this.flash);

    // Virtual touch controls for coarse-pointer / portrait-mobile layouts
    // (CSS decides visibility). Buttons dispatch synthetic KeyboardEvents,
    // so the P1 KeyboardController — including hold-to-charge and the
    // tap-vs-hold block key — works unchanged. Demo mode is CPU vs CPU,
    // so no controls there.
    if (this.options.mode !== 'demo') this._buildTouchControls();

    // Inter-round splash. Created once; reused via _showSplash() so the
    // browser doesn't pay the cost of mounting a new DOM node every match.
    this.splash = document.createElement('div');
    this.splash.className = 'pb-splash';
    this.splash.innerHTML = `
      <div class="pb-splash__inner">
        <div class="pb-splash__round"></div>
        <div class="pb-splash__versus">VS</div>
        <div class="pb-splash__p1"></div>
        <div class="pb-splash__p2"></div>
      </div>`;
    this.container.appendChild(this.splash);
    this._splashHide = 0; // wall-clock at which the splash should fade out

    this._onResize = () => {
      const cw = this.container.clientWidth, ch = this.container.clientHeight;
      if (!cw || !ch) return;
      this.camera.aspect = cw / ch;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(cw, ch);
      this.composer.setSize(cw, ch);
      // BokehPass owns render targets sized independently of the composer's;
      // without this its depth buffer keeps the old aspect and the blur skews.
      if (this.rackFocus) this.rackFocus.setSize(cw, ch);
    };
    window.addEventListener('resize', this._onResize);

    // Build the physics world before spawning fighters — per-fighter bodies
    // (kinematic rig-root + dynamic hurt spheres) are created in _spawnFighters.
    this._physics = createPhysicsWorld();
    this._setupPhysicsCollisions();
    // Static post/rope colliders — only the KO ragdoll interacts with them.
    buildArenaColliders(this._physics.world, this._physics.materials);
    // Destructible corner crates + debris (props.js). The hooks let the module
    // deal chip damage / spawn impact FX back through the engine.
    this._propHooks = this._makePropHooks();
    this.props = buildProps(this._physics.world, this._physics.materials, this.scene);
    this._spawnFighters(this.options.p1Character, this.options.p2Character);
    // Textures are built by arena.js/fighters.js as module-level cached
    // singletons with no renderer handle, so none of them could set anisotropy
    // themselves — every map was sampling at 1x. Apply it once here, after the
    // first arena+fighter build has created them; later rounds reuse the same
    // cached texture objects and stay filtered.
    this._applyTextureAnisotropy();
    this._startCountdown();
    this._warmupRender();

    // Kick the audio context the first time the user interacts with the page —
    // .razor lifecycle alone doesn't always satisfy autoplay policy.
    const resumeAudio = () => {
      this.audio.resume();
      this.audio.startMusic();
      window.removeEventListener('pointerdown', resumeAudio);
      window.removeEventListener('keydown', resumeAudio);
    };
    window.addEventListener('pointerdown', resumeAudio);
    window.addEventListener('keydown', resumeAudio);

    this.lastFrame = performance.now();
    const loop = (now) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const rawDt = (now - this.lastFrame) / 1000;
      let dt = Math.min(rawDt, MAX_FRAME_DT);
      this.lastFrame = now;

      this.accumulator += dt * this.timeScale;
      while (this.accumulator >= SIM_DT) {
        this.accumulator -= SIM_DT;
        this._tick(SIM_DT);
      }
      this._updateCamera(dt);
      this._updateEffects(dt);
      this._updateCrowd(dt);
      this._updateFx(dt);
      this._updateLighting(dt);
      this.atmoT += dt;
      updateAtmosphere(this.arena, dt, this.atmoT, this.excited);
      updateRopes(this.arena, dt, this.fighters, this.atmoT);
      updateBanners(this.arena.backdrop, this.atmoT);
      if (this.props) updateProps(this.props, dt, this.fighters, this._propHooks);
      this._updateBlobShadows();
      if (this.fighters) {
        for (const f of this.fighters) {
          updateJiggles(f.rig, dt);
          this._updateTrail(f, dt);
          // Transient 'hurt' faces relax back to the resting expression.
          // KO'd fighters keep the dazed face under the result modal.
          if (f.expressionT > 0) {
            f.expressionT -= dt;
            if (f.expressionT <= 0 && f.state !== 'ko') {
              setExpression(f.rig, 'neutral');
            }
          }
        }
      }
      this.composer.render();
    };
    this.raf = requestAnimationFrame(loop);
  }

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
    // Disposed above with the rest of the passes; drop the handle so a stale
    // one cannot be updated against the new composer.
    this.rackFocus = null;

    const pixelRatio = window.PoCanvasDpr.ceiling();   // audit #8: shared policy, js/canvasDpr.js
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h);

    // Bloom threshold sits just under the spark/hit-flash luminance so
    // impacts glow while the arena itself stays clean.
    // MSAA render target — the composer's default target has no samples,
    // which would drop the AA the raw canvas had.
    const composerRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: 4,
    });
    this.composer = new EffectComposer(this.renderer, composerRT);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Ground-truth AO: contact-level darkening in armpits, under ropes and
    // between crowd rows that flat hemisphere ambient destroys.
    try {
      const gtao = new GTAOPass(this.scene, this.camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 0.85;
      this.composer.addPass(gtao);
    } catch { /* AO is a nicety — never block the game on it */ }
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.32, 0.55, 0.8);
    this.composer.addPass(this.bloomPass);
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

  _makeController(playerIndex) {
    const mode = this.options.mode;
    const difficulty = this.options.difficulty || 'medium';
    // Each AI controller also learns its charId so it can pull personality
    // additive AI knobs (HW Bush's blockP/baitP/punishP bump).
    const charIdForIndex = playerIndex === 1
      ? this.options.p1Character
      : this.options.p2Character;
    if (mode === 'demo') return new AiController(difficulty, this.rng, charIdForIndex);
    if (mode === '2p') return new KeyboardController(playerIndex);
    return playerIndex === 1
      ? new KeyboardController(1)
      : new AiController(difficulty, this.rng, charIdForIndex);
  }

  _spawnFighters(p1Char, p2Char) {
    if (this.fighters) {
      for (const f of this.fighters) {
        // Tear down any active swing physics before disposing the fighter.
        if (f.swingPhysics) destroySwingPhysics(this._physics.world, f.swingPhysics);
        // Dispose cannon bodies we created for this fighter.
        this._removeFighterPhysics(f);
        if (f.koRagdoll) f.koRagdoll.dispose();
        this.scene.remove(f.rig.root);
        if (f.blob) {
          this.scene.remove(f.blob);
          f.blob.geometry.dispose();
          f.blob.material.dispose(); // texture is shared; disposed in dispose()
        }
        if (f.aoDisc) {
          this.scene.remove(f.aoDisc);
          f.aoDisc.geometry.dispose();
          f.aoDisc.material.dispose();
        }
        if (f.trail) {
          this.scene.remove(f.trail.mesh);
          f.trail.mesh.geometry.dispose();
          f.trail.mesh.material.dispose();
        }
        f.controller.dispose();
      }
    }

    // A fresh match starts on a clean canvas — the accumulated blood
    // stains belong to the fight that produced them.
    if (this._bloodStains) {
      for (const s of this._bloodStains) this.scene.remove(s);
      this._bloodStains.length = 0;
    }

    // Clear any arms torn off in the previous fight.
    if (this._pendingSevers) this._pendingSevers.length = 0;
    if (this._severedLimbs) {
      for (const l of this._severedLimbs) {
        if (l.arm) l.arm.dispose();
        for (const obj of [l.shoulder, l.elbow]) {
          if (!obj) continue;
          this.scene.remove(obj);
          obj.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
          });
        }
      }
      this._severedLimbs.length = 0;
    }

    this.combat = new CombatPlay({ maxHealth: MAX_HP });
    this.replay.start();

    this.fighters = [1, 2].map((index) => {
      const charId = index === 1 ? p1Char : p2Char;
      const resolvedId = CHARACTERS[charId] ? charId : CHARACTER_IDS[0];
      const rig = buildFighter(resolvedId);
      // Spawn on the same side as this fighter's energy bar in the Blazor HUD
      // (see SPAWN_X_BY_SIDE at the top of the file). The camera at +Z
      // looking toward −Z renders negative X on the screen-left and positive
      // X on the screen-right, matching `pb-hp-side` (P1) and `pb-hp-right`
      // (P2) respectively.
      const side = index === 1 ? 'left' : 'right';
      rig.root.position.set(SPAWN_X_BY_SIDE[side], 0, 0);
      this.scene.add(rig.root);
      const playerId = `p${index}`;
      this.combat.addPlayer({ playerId, teamId: String(index) });

      // Build cannon-es bodies for this fighter. The kinematic rig-root
      // handles push-apart with the opponent; the dynamic hurt spheres +
      // DistanceConstraints are what the strikers collide with.
      const initialXZ = { x: rig.root.position.x, z: rig.root.position.z };
      const fighterPhysics = buildFighterPhysics(this._physics.world, this._physics.materials, { rig }, initialXZ);

      // Soft contact shadow + ambient-occlusion disc. Two stacked planes:
      //   • blob — the existing shadow blob (radial gradient that darkens
      //     and widens as the fighter drops; sells vertical grounding)
      //   • aoDisc — a tight, near-pitch-black inner ring that hugs the
      //     planted foot. Reads as ambient occlusion, not cast shadow —
      //     sells horizontal contact (the fighter isn't floating).
      const blob = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 1.5),
        new THREE.MeshBasicMaterial({
          map: this._makeBlobTexture(), transparent: true,
          opacity: 0.34, depthWrite: false,
        })
      );
      blob.rotation.x = -Math.PI / 2;
      blob.position.y = 0.055;
      this.scene.add(blob);

      // AO disc scales with mass — heavy fighters (LBJ mass 1.25) get a
      // visibly larger plant patch than light fighters (JFK mass 0.9).
      const aoR = 0.95 * Math.sqrt(rig.config.mass || 1.0);
      const aoDisc = new THREE.Mesh(
        new THREE.PlaneGeometry(aoR * 2, aoR * 2),
        new THREE.MeshBasicMaterial({
          map: this._makeBlobTexture({ inner: 'rgba(0,0,0,0.85)', outer: 'rgba(0,0,0,0)' }),
          transparent: true, opacity: 0.55, depthWrite: false,
        })
      );
      aoDisc.rotation.x = -Math.PI / 2;
      aoDisc.position.y = 0.056; // 1 mm above blob to avoid z-fight
      this.scene.add(aoDisc);

      return {
        index,
        playerId,
        // 'left' | 'right' — mirrors the side this fighter's HUD bar is drawn
        // on by Blazor, and the X coordinate they spawned at. Single source of
        // truth for any code that needs "which side am I on?" (camera framing,
        // KO camera, replay, future AI hints). Set above; do not mutate after
        // spawn — moving across the ring is tracked separately on `vel.x`.
        side,
        // Resolved character id (demo mode reshuffles these every reset — the
        // HUD reads it back via the OnMatchStart callback so the on-screen
        // names always match the actual fighters).
        charId: resolvedId,
        rig,
        // Stance offsets give each president a personal idle silhouette
        // (Trump's chin-up lean, Nixon's hunch) on top of the shared guard.
        animator: new Animator(rig.joints, rig.config.stance),
        controller: this._makeController(index),
        // Personality entrance — played under the "3 / 2 / 1 / FIGHT!" banner
        // during _startCountdown. Resolves to GUARD by the time FIGHT! fires.
        entranceKey: (CHARACTERS[charId] && CHARACTERS[charId].entrance) || 'salute',
        state: 'idle',
        stateT: 0,
        attack: null,
        hasHit: false,
        // ── Hold-to-charge ────────────────────────────────────────────
        chargeName: null,  // 'punch'|'kick' while state === 'charge'
        chargeAmt: 0,      // 0..1 stored charge (mirrors energy while charging)
        chargeMul: 1,      // damage/knockback multiplier of the current swing
        energy: ENERGY_DEFAULT, // 0..1 banked attack power; starts at 1/3 (see ENERGY_DEFAULT)
        // Super meter (0..1): fills by taking damage. ≥ 1 → superQueued fires
        // PERSONALITIES[charId].onSuper; consumes to zero regardless of fill.
        // Driven by _tickSuperMeter each tick; updated by _fireSuper on press.
        superMeter: 0,
        chargeCued: false, // full-charge audio cue fired
        chargeSparkT: 0,   // spark-mote emission timer
        // ── Momentum + weight ─────────────────────────────────────────
        vel: new THREE.Vector3(),
        targetVel: new THREE.Vector3(),
        knockback: new THREE.Vector3(),
        sideVel: new THREE.Vector3(),
        // ── Per-region damage ─────────────────────────────────────────
        regionDmg: { head: 0, torso: 0, arms: 0, legs: 0 },
        // ── Dismemberment ─────────────────────────────────────────────
        // Which arm sides ('L'/'R') have torn off, plus the still-bleeding
        // stumps that keep squirting for a beat. See _severArm / _tick.
        armsLost: new Set(),
        stumps: [],
        // ── Misc ──────────────────────────────────────────────────────
        idleT: this.rng.random() * 10,
        speedAmt: 0,
        // Facial expression timer: >0 while a transient 'hurt' face is held.
        expressionT: 0,
        // Rotational knockback: yaw angular velocity + accumulated offset
        // layered on top of the hard-set facing (see the yaw-track block).
        spinVel: 0,
        spinYaw: 0,
        // Skid/landing ground-reaction state.
        _skidT: 0,
        _wasSkidding: false,
        // ── Personality state (per-president Punch-Out!! pattern) ──────
        // Runtime counters that personalities data above refer to. Reset on
        // match restart via _resetPersonalities below.
        personality: makePersonalityState(resolvedId),
        // Slow effect (Biden charge hit): applies a moveMul to the body for
        // a few seconds. Read in the _tickFighting mobility pass.
        slowUntil: 0,
        slowMul: 1.0,
        // Block-reduce nudge (Nixon "Tricky Dick"): on the next commit dirty
        // hit, the defender's block absorbs `dirtyBlockFraction` less.
        dirtyBlockReduce: 0,
        hpCur: MAX_HP,
        // Impact feedback: cartoon squash timer (shape only — per user request
        // the model's colors never change on hits or KO).
        squashT: 0,
        // Soft contact-shadow mesh (tracks the hips each frame).
        blob,
        // AO disc: mass-tinted "planted foot" patch. Tighter than blob,
        // never widens with drop — it just anchors the fighter to the floor.
        aoDisc,
        // Additive swing ribbon following the striking limb.
        trail: this._makeTrail(),
        // Track the last frame's windup flag for the AI to read.
        lastWasWindup: false,
        // Rigid-body ragdoll — the real cannon-es skeleton used for the KO.
        // Built lazily (pendingKO) because KOs can fire inside world.step.
        koRagdoll: new CannonRagdoll(this._physics.world, this._physics.materials.ragdoll, rig),
        pendingKO: null,
        // Cannon-es physics — kinematic rig root + dynamic hurt spheres.
        fighterPhysics,
        // Active swing bodies (striker spheres). Created on _enterAttack,
        // destroyed when swing transitions to idle or KO interrupts.
        swingPhysics: null,
      };
    });
    this.hudDirty = true;
    this.hudTimer = 0;
    // Tell the HUD which characters actually spawned so the left/right names
    // match the fighters — critical in demo mode, where resetMatch reshuffles
    // the roster without the Blazor layer knowing.
    if (this.dotnet) {
      this.dotnet.invokeMethodAsync('OnMatchStart',
        this.fighters[0].charId, this.fighters[1].charId).catch(() => {});
    }
  }

  _hp(f) {
    return Math.max(0, Math.round(this.combat.getPlayer(f.playerId).health));
  }

  _startCountdown() {
    this.phase = 'countdown';
    this.phaseT = 0;
    this.clock = 0;
    this.winner = 0;
    // Rebuild the corner crate stacks so each round opens with an intact ring.
    if (this.props) resetProps(this.props);
    // Land the previous match's celebrant before the fresh countdown.
    if (this.celebrant) this.celebrant.rig.root.position.y = 0;
    this.celebrant = null;
    this.pendingCelebration = null;
    this.celebrationT = 0;
    this.timeScale = 1;
    this.cameraMode = 'normal';
    this.cameraModeT = 0;
    // Snap the boom back to the canonical +Z side before the round starts.
    // The KO cinematic swings the camera around to the −Z side of the ring
    // (see _updateCamera 'ko' branch), and the normal spring camera's
    // perp-flip keeps whatever side it's already on — so without this reset
    // the next round is filmed from behind, mirroring the arena: P1 (world
    // −X, drawn on the screen-left in the HUD) would render on the right and
    // the left/right names read swapped against the fighters. Resetting here
    // guarantees screen-left always maps to P1.
    this._snapCameraToFraming();
    // Kick the personality entrance for each fighter. The track lasts ~1.5 s
    // (3-4 keyframes); the countdown is 3.7 s, so the entrance resolves to
    // GUARD before FIGHT! fires and the match starts clean.
    if (this.fighters) {
      for (const f of this.fighters) {
        if (f.animator && f.entranceKey) f.animator.play(f.entranceKey);
      }
      // Period-appropriate chiptune intro for the opponent (P2). Plays on
      // introGain while the music loop ducks; fades back up after ~5 s.
      if (this.audio && this.fighters[1]) {
        this.audio.playIntroTheme(this.fighters[1].charId);
      }
    }
    this._setBanner('3');
  }

  // Compile every GPU program the current scene needs, then reset the frame
  // clock. three compiles a material's shader lazily, on its first render;
  // with this many distinct materials (arena + backdrop + crowd + props + two
  // freshly built fighters + the whole post chain) that lands as one long
  // stall on the first animated frame of a match. It doesn't just drop the
  // opening camera move — a main-thread block that long also starves the
  // music scheduler's setInterval past its lookahead window, so the bass line
  // hiccups at the same moment. That combination is the "everything stutters
  // at the start of a round" symptom. Warming up here spends the same time,
  // but spends it before the clock starts / behind the round splash.
  _warmupRender() {
    try {
      this.renderer.compile(this.scene, this.camera);
      this.composer.render();
    } catch { /* best effort — never block the match on the warm-up */ }
    // Don't bill the warm-up to the simulation: the next frame's dt is
    // measured from here, and no catch-up ticks are owed.
    this.lastFrame = performance.now();
    this.accumulator = 0;
  }

  resetMatch(randomize) {
    let p1 = this.options.p1Character, p2 = this.options.p2Character;
    if (randomize) {
      const ids = this.rng.shuffle(CHARACTER_IDS);
      [p1, p2] = ids;
    }
    this._spawnFighters(p1, p2);
    // New rigs mean new materials: compile them under the splash rather than
    // on the countdown's first frame.
    this._warmupRender();
    // Show the inter-round splash, then start the countdown once it's
    // faded in. The splash doubles as a brief loading screen — the new
    // match's physics + arena are ready under it, so the transition reads
    // as "next round" rather than "page reload".
    this._showSplash(p1, p2, /* holdMs */ 1300);
    setTimeout(() => { this._hideSplash(); this._startCountdown(); }, 1300);
  }

  _showSplash(p1Char, p2Char, holdMs) {
    const p1 = CHARACTERS[p1Char]?.name ?? p1Char;
    const p2 = CHARACTERS[p2Char]?.name ?? p2Char;
    this.splash.querySelector('.pb-splash__round').textContent =
      this.options.mode === 'demo' ? 'DEMO' : 'NEXT ROUND';
    this.splash.querySelector('.pb-splash__p1').textContent = p1;
    this.splash.querySelector('.pb-splash__p2').textContent = p2;
    this.splash.classList.add('pb-splash--visible');
  }

  _hideSplash() {
    this.splash.classList.remove('pb-splash--visible');
  }

  // ── simulation ──────────────────────────────────────────────────────────

  _tick(dt) {
    this.phaseT += dt;

    if (this.phase === 'countdown') {
      const remaining = 3 - Math.floor(this.phaseT);
      this._setBanner(remaining > 0 ? String(remaining) : 'FIGHT!');
      if (this.phaseT >= 3.7) {
        this.phase = 'fighting';
        this.combat.startGame();
        this._setBanner('');
      }
    } else if (this.phase === 'fighting') {
      this.clock += dt;
      this._tickFighting(dt);
      if (this.clock >= TIME_LIMIT && this.phase === 'fighting') {
        const h1 = this._hp(this.fighters[0]), h2 = this._hp(this.fighters[1]);
        // Per user request: a no-KO finish always has a winner. The fighter
        // with more energy left takes the decision; only an exact-equal
        // (literally the same HP to the unit) is a draw — and even then
        // we still pick a winner by index rather than call it a draw.
        let winner;
        if (h1 > h2) winner = 1;
        else if (h2 > h1) winner = 2;
        else winner = 1; // exact tie → P1 by default; never report 0 here
        this._endMatch(winner, 'TIME!');
      }
    } else if (this.phase === 'ko') {
      // Build any pending rigid-body ragdoll now — we're guaranteed to be
      // outside cannon's step here, so body removal/creation is safe.
      this._buildPendingKO();
      this._buildPendingSevers();
      if (this._physics) stepWorld(this._physics.world, dt);
      this._tickKoFall(dt);
      this._tickReplay(dt);
      if (this.phaseT >= 1.4) {
        this.timeScale = 1;
        this.phase = 'result';
        this.phaseT = 0;
        this._startCelebration(this.pendingCelebration);
        this._reportResult();
      }
    } else if (this.phase === 'result') {
      this._buildPendingKO();
      this._buildPendingSevers();
      if (this._physics) stepWorld(this._physics.world, dt);
      this._tickKoFall(dt);
      this._tickCelebration(dt);
      if (this.options.mode === 'demo' && this.phaseT >= 3) {
        this.resetMatch(true);
      }
    }

    // Hit-pause countdown: skip sim while paused but still advance render rate later.
    if (this.hitstopT > 0) {
      this.hitstopT = Math.max(0, this.hitstopT - dt);
    }
    if (this._clashCooldown > 0) this._clashCooldown -= dt;

    for (const f of this.fighters) {
      f.idleT += dt;
      const opp = f === this.fighters[0] ? this.fighters[1] : this.fighters[0];
      this._updatePosture(f, opp, dt);
      // Per-fighter personality evaluation: trigger-once modes, slow clears,
      // flourish scheduling.
      this._tickPersonalities(f, dt);
      this._tickClintonFlourish(f, dt);
      f.animator.update({
        dt, speed: f.speedAmt, idleT: f.idleT,
        root: f.rig.root,
        vel: _animVel.set(f.vel.x + f.knockback.x, 0, f.vel.z + f.knockback.z),
      });
      f.animator.decayLean(dt);
      f.hpCur = this._hp(f);

      // NOTE: the experimental hitstun ragdoll-blend was removed after joint
      // telemetry showed its per-tick quaternion slerp COMPOUNDS against the
      // animator's lerp — the spine converged toward the flying verlet pose
      // (70°+ folds) instead of adding a subtle flavor on top. The reaction
      // springs + hitstun track are the hit reaction now, tuned to a
      // realistic 5-15° deflection.

      // Cartoon squash: compress the whole body for a couple of frames on impact.
      if (f.squashT > 0) {
        f.squashT = Math.max(0, f.squashT - dt);
        const q = f.squashT / 0.14;
        const s = q * q * 0.2;
        f.rig.joints.hips.scale.set(1 + s * 0.8, 1 - s, 1 + s * 0.8);
      }

      // Bleeding stumps: keep squirting from the torn shoulder socket for a beat.
      if (f.stumps && f.stumps.length) {
        for (let n = f.stumps.length - 1; n >= 0; n--) {
          const st = f.stumps[n];
          st.t -= dt;
          st.emit -= dt;
          if (st.emit <= 0) {
            st.emit = 0.07;
            // Shoulder socket in torso-local space (see fighters.js: shoulder at
            // x = ±0.28·buildScale, y = 0.5), lifted to world.
            const socket = new THREE.Vector3(
              (st.side === 'L' ? -1 : 1) * 0.28 * f.rig.config.buildScale, 0.5, 0);
            f.rig.joints.torso.localToWorld(socket);
            const out = new THREE.Vector3(st.side === 'L' ? -1 : 1, 0.5, 0).normalize();
            this._bloodSquirt(socket, out, 1.1);
          }
          if (st.t <= 0) f.stumps.splice(n, 1);
        }
      }
    }

    // Drive music tension from the lower of the two HPs (0..1 → 0..1).
    if (this.fighters && this.fighters.length) {
      const low = Math.min(...this.fighters.map((f) => f.hpCur)) / MAX_HP;
      this.audio.setMusicTension(1 - low);
    }

    // Audio-reactive bloom: every SFX call nudges the AudioBus envelope;
    // here we decay it and pulse UnrealBloomPass strength so each impact
    // glows brighter for ~150 ms. Base 0.32, peak +0.6, eased back via
    // exp-decay (k ≈ 7.5 in audio.tick).
    if (this.audio && typeof this.audio.tick === 'function') this.audio.tick(dt);
    if (this.bloomPass) {
      const env = (this.audio && this.audio.getEnvelope) ? this.audio.getEnvelope() : 0;
      const target = 0.32 + env * 0.6;
      // Smoothly chase the target so back-to-back hits stack without snap.
      const k = 1 - Math.exp(-dt * 18);
      this.bloomPass.strength = this.bloomPass.strength + (target - this.bloomPass.strength) * k;
    }

    this._pushHud(dt);
    this.replay.record({ clock: this.clock, fighters: this.fighters });
  }

  _tickFighting(dt) {
    const [f1, f2] = this.fighters;

    // Skip sim while in hit-pause.
    if (this.hitstopT > 0) return;

    for (const f of this.fighters) {
      const opp = f === f1 ? f2 : f1;
      const ctx = this._aiContext(f, opp, dt);
      let intent = f.controller.update(ctx);
      // ── Nixon "I Am Not a Crook" eye-gouge ──────────────────────────
      // 30% of block presses drop during the 0.3 s blind window. The simplest
      // realization is to clear the `block` flag with miss-rate probability.
      // Ford "PARDON ME" super: same channel, higher miss-rate (60%), longer
      // window (1.0 s). The runtime miss rate is read from
      // f._inputBlindMissRate so future supers can reuse this without a
      // new branch.
      if (f._inputBlindUntil && this.t < f._inputBlindUntil) {
        const missRate = f._inputBlindMissRate
          || PERSONALITIES.nixon?.oncePerRound?.blindMissRate
          || 0.30;
        if (Math.random() < missRate) intent = { ...intent, block: false };
      }
      // ── W Bush "Decider Mode" freeze: stall out his attacking moves ──
      if (f.controller?.__freezeUntil && this.t < f.controller.__freezeUntil) {
        intent = { ...intent, punch: false, kick: false, side: 0 };
      }
      this._tickFighter(f, opp, intent, dt);
      // Super meter fills passively by taking damage (see _tickSuperMeter).
      // Drain any activated super state, decay swing-counted supers.
      this._tickSuperMeter(f, opp, dt);
    }

    // ── Ring clamp + cannon-es physics step ────────────────────────
    // 1. Clamp each fighter inside the ring (still the engine's job — cannon
    //    wouldn't otherwise know about the arena boundary). A fighter thrown
    //    hard into the boundary rebounds off the ropes instead of sticking.
    for (const f of this.fighters) {
      const pos = f.rig.root.position;
      const rawX = pos.x, rawZ = pos.z;
      pos.x = THREE.MathUtils.clamp(rawX, -RING_HALF, RING_HALF);
      pos.z = THREE.MathUtils.clamp(rawZ, -RING_HALF, RING_HALF);
      // Elastic rope rebound (#3): the ropes catch a launched fighter and
      // spring them back INTO the ring. Harder impacts snap back harder
      // (restitution ramps 0.55 → 0.9 with incoming speed) instead of the old
      // flat 0.65 — a hard knockback into the ropes now rebounds like a real
      // rope-a-dope bounce rather than a dead stop.
      if (pos.x !== rawX && Math.abs(f.knockback.x) > 1.2) {
        const speed = Math.abs(f.knockback.x);
        const power = Math.min(2.6, speed / 3.5);
        const restitution = THREE.MathUtils.clamp(0.55 + speed * 0.05, 0.55, 0.9);
        f.knockback.x *= -restitution;
        f.animator.applyLean(0, rawX > 0 ? 0.4 : -0.4);
        f.animator.applyReaction('torso', -3, 0, 0);
        twangRope(this.arena, 'x', rawX > 0 ? 1 : -1, power);
      }
      if (pos.z !== rawZ && Math.abs(f.knockback.z) > 1.2) {
        const speed = Math.abs(f.knockback.z);
        const power = Math.min(2.6, speed / 3.5);
        const restitution = THREE.MathUtils.clamp(0.55 + speed * 0.05, 0.55, 0.9);
        f.knockback.z *= -restitution;
        f.animator.applyLean(rawZ > 0 ? -0.4 : 0.4, 0);
        f.animator.applyReaction('torso', -3, 0, 0);
        twangRope(this.arena, 'z', rawZ > 0 ? 1 : -1, power);
      }

      // Turnbuckle hazard (#9): a fighter knocked into a CORNER takes bonus
      // damage and is flung back toward ring-center harder than a plain rope
      // bounce. Cooldown-gated so a body wedged in the corner isn't shredded.
      f._cornerCd = Math.max(0, (f._cornerCd || 0) - dt);
      const inCorner = Math.abs(pos.x) > RING_HALF - 0.5 && Math.abs(pos.z) > RING_HALF - 0.5;
      const cornerKb = Math.hypot(f.knockback.x, f.knockback.z);
      if (inCorner && cornerKb > 3.0 && f._cornerCd === 0 && f.state !== 'ko') {
        f._cornerCd = 0.6;
        const sx = Math.sign(pos.x) || 1, sz = Math.sign(pos.z) || 1;
        const tox = -sx / Math.SQRT2, toz = -sz / Math.SQRT2; // toward center
        f.knockback.x = tox * cornerKb * 0.7;
        f.knockback.z = toz * cornerKb * 0.7;
        f.animator.applyReaction('torso', -3.5, 0, 0);
        this._propHooks.onChip(f, Math.min(4, cornerKb - 3.0), tox, toz);
        const pv = new THREE.Vector3(sx * (RING_HALF + 0.1), 1.0, sz * (RING_HALF + 0.1));
        this._spawnSparks(pv, sx < 0 ? 0xff5a4a : 0x4a7dff, 10, 2.2);
        this.audio.impact({ power: 1.3, worldPos: pv });
      }

      // ── Ground reaction: skids and landings ────────────────────────
      // Heavy knockback drags the feet: kick up canvas dust along the
      // slide, then a landing squash when the body finally grips.
      const kb = Math.hypot(f.knockback.x, f.knockback.z);
      if (kb > 3.2 && f.state !== 'ko') {
        f._wasSkidding = true;
        f._skidT -= dt;
        if (f._skidT <= 0) {
          f._skidT = 0.05;
          this._spawnParticle(
            pos.x + (this.rng.random() - 0.5) * 0.25, 0.1,
            pos.z + (this.rng.random() - 0.5) * 0.25,
            -f.knockback.x * 0.12, 0.7 + this.rng.random() * 0.6, -f.knockback.z * 0.12,
            0x8a8fb8, 0.4, -2.5);
        }
      } else if (f._wasSkidding && kb < 1.6) {
        // The slide grips: compress into the landing.
        f._wasSkidding = false;
        f.squashT = Math.max(f.squashT, 0.12);
      }
    }

    // 2. Sync cannon bodies to current rig transforms BEFORE stepping so
    //    the solver sees the fighter where the controllers put them.
    if (this._physics) {
      for (const f of this.fighters) {
        if (f.state !== 'ko' && f.fighterPhysics) {
          syncHurtSpheres(f, f.fighterPhysics.hurtSpheres);
          syncRigRoot(f.fighterPhysics.rigRoot, f);
          if (f.swingPhysics) {
            const phase = (f.stateT > (f.attack?.windup ?? 0) + (f.attack?.active ?? 0))
              ? 'recover' : 'active';
            syncStrikerSpheres(f, f.swingPhysics.spheres, f.state, phase);
          }
        }
      }
      stepWorld(this._physics.world, dt);
      // An arm torn off inside this step's beginContact dispatch gets its
      // bodies built here, now that we're safely outside world.step.
      this._buildPendingSevers();

      // 3. Push-apart via cannon-es contact events. When two kinematic
      //    rig-roots overlap, cannon reports a contact but doesn't move
      //    them by itself. We translate each root by half the deficit
      //    along the contact normal — same effect as the old
      //    MIN_SEPARATION code, but driven by cannon's broadphase +
      //    narrowphase instead of a single point-distance check.
      for (const f of this.fighters) {
        if (f.state !== 'ko' && f.fighterPhysics) {
          for (const c of this._physics.world.contacts) {
            const a = c.bi, b = c.bj;
            if (a === f.fighterPhysics.rigRoot || b === f.fighterPhysics.rigRoot) {
              const other = a === f.fighterPhysics.rigRoot ? b : a;
              if (!other.userData || other.userData.kind !== 'rigRoot') continue;
              const dx = f.fighterPhysics.rigRoot.position.x - other.position.x;
              const dz = f.fighterPhysics.rigRoot.position.z - other.position.z;
              const d = Math.hypot(dx, dz) || 1e-4;
              const overlap = (f.fighterPhysics.rigRoot.shapes[0].radius +
                              other.shapes[0].radius) - d;
              if (overlap > 0) {
                const nx = dx / d, nz = dz / d;
                const push = overlap * 0.5;
                f.fighterPhysics.rigRoot.position.x += nx * push;
                f.fighterPhysics.rigRoot.position.z += nz * push;
                other.position.x -= nx * push;
                other.position.z -= nz * push;
              }
            }
          }
        }
      }

      // 3b. Cannon never generates contacts between the two rig roots —
      //    both are KINEMATIC, and the broadphase skips pairs with no
      //    dynamic body — so the contact loop above only handles ragdoll
      //    shoves. Enforce the fighter-vs-fighter minimum separation
      //    directly: half the deficit each, XZ only.
      const [fA, fB] = this.fighters;
      if (fA.state !== 'ko' && fB.state !== 'ko'
          && fA.fighterPhysics && fB.fighterPhysics) {
        const pa = fA.fighterPhysics.rigRoot.position;
        const pb = fB.fighterPhysics.rigRoot.position;
        const dx = pa.x - pb.x, dz = pa.z - pb.z;
        const d = Math.hypot(dx, dz) || 1e-4;
        if (d < MIN_SEPARATION) {
          const push = (MIN_SEPARATION - d) * 0.5;
          const nx = dx / d, nz = dz / d;
          pa.x += nx * push; pa.z += nz * push;
          pb.x -= nx * push; pb.z -= nz * push;

          // Body-check shove (#2): the part of each fighter's knockback driving
          // INTO the other is transferred, so charging/knocked into an opponent
          // shoves them instead of both sliding to a dead stop at the clamp.
          const aInto = -(fA.knockback.x * nx + fA.knockback.z * nz); // A → B
          if (aInto > 0.4) {
            fB.knockback.x += -nx * aInto * 0.45;
            fB.knockback.z += -nz * aInto * 0.45;
            fA.knockback.x -= -nx * aInto * 0.2;
            fA.knockback.z -= -nz * aInto * 0.2;
          }
          const bInto = (fB.knockback.x * nx + fB.knockback.z * nz);  // B → A
          if (bInto > 0.4) {
            fA.knockback.x += nx * bInto * 0.45;
            fA.knockback.z += nz * bInto * 0.45;
            fB.knockback.x -= nx * bInto * 0.2;
            fB.knockback.z -= nz * bInto * 0.2;
          }
        }
      }

      // 4. Read rig-root positions back into the THREE rigs so the visual
      //    matches the kinematic body.
      for (const f of this.fighters) {
        if (f.state !== 'ko' && f.fighterPhysics) {
          const p = f.fighterPhysics.rigRoot.position;
          f.rig.root.position.x = p.x;
          f.rig.root.position.z = p.z;
        }
      }
    }

    // Post collisions: high-momentum knockback against breakable props.
    for (const f of this.fighters) {
      for (const post of this.arena.posts) {
        if (!post.userData.breakable || !post.visible) continue;
        const d = post.position.clone().sub(f.rig.root.position);
        d.y = 0;
        const horiz = Math.hypot(d.x, d.z);
        if (horiz < 0.55 && f.knockback.lengthSq() > 6) {
          const chunks = damagePost(post, 30, this.scene);
          this.effects.push(...chunks.map((c) => ({ mesh: c, life: c.userData.life })));
          // Reflect knockback and dampen hard.
          f.knockback.multiplyScalar(-0.3);
          this._spawnSparks(post.position, 0xc8a060, 8, 1.5);
          this.audio.impact({ power: 1.0, worldPos: post.position });
        }
      }
    }

    // Face each other (yaw only). A body lying on the canvas doesn't yaw-track.
    // Rotational knockback rides on top as a decaying yaw offset: a hook
    // spins the defender off-facing, then they recover square.
    for (const f of this.fighters) {
      const opp = f === f1 ? f2 : f1;
      if (f.state !== 'ko') {
        if (f.spinVel !== 0 || f.spinYaw !== 0) {
          f.spinYaw += f.spinVel * dt;
          f.spinYaw = THREE.MathUtils.clamp(f.spinYaw, -0.7, 0.7);
          f.spinVel *= Math.exp(-dt * 5.5);
          f.spinYaw *= Math.exp(-dt * 4);
          if (Math.abs(f.spinVel) < 0.02 && Math.abs(f.spinYaw) < 0.005) {
            f.spinVel = 0;
            f.spinYaw = 0;
          }
        }
        const p = opp.rig.root.position;
        f.rig.root.rotation.y = Math.atan2(
          p.x - f.rig.root.position.x, p.z - f.rig.root.position.z) + f.spinYaw;
      }
    }
  }

  _aiContext(f, opp, dt) {
    const dist = f.rig.root.position.distanceTo(opp.rig.root.position);
    const oppAttack = (opp.state === 'punch' || opp.state === 'kick') ? opp.attack : null;
    // A charging opponent reads as windup — the coil is the tell to block.
    const oppInWindup = opp.state === 'charge'
      || (!!oppAttack && opp.stateT < oppAttack.windup);
    const oppInActive = !!oppAttack && opp.stateT >= oppAttack.windup
      && opp.stateT <= oppAttack.windup + oppAttack.active;
    const oppInRecover = !!oppAttack && opp.stateT > oppAttack.windup + oppAttack.active;
    return {
      dt,
      distance: dist,
      // Sign of (opponent.x − self.x): +1 when the opponent is to our right,
      // −1 when to our left. The keyboard controller uses this to keep the
      // left/right keys screen-relative regardless of which side we're on.
      towardX: Math.sign(opp.rig.root.position.x - f.rig.root.position.x) || 1,
      kickRange: ATTACKS.kick.reach * opp.rig.config.heightScale + 0.3,
      opponentWindup: oppInWindup,
      opponentActive: oppInActive,
      opponentRecover: oppInRecover,
      opponentState: opp.state,
      ownAttacks: ATTACKS,
      // Super meter full? Exposed so the AI's super-activation block knows
      // when it has a budget to spend. Player controllers don't read this —
      // their intent.super is driven by the super key directly.
      superMeterFull: (f.superMeter || 0) >= 1.0,
    };
  }

  _tickFighter(f, opp, intent, dt) {
    f.stateT += dt;
    const pos = f.rig.root.position;
    const effect = regionEffect(f.regionDmg);
    const moveSpeed = intent.move > 0 ? 2.4 : 1.9;
    const moveAccel = f.rig.config.moveAccel * 0.5; // tune base accel

    f.speedAmt = 0;

    // ── Movement with momentum ────────────────────────────────────────
    // Compute a desired world velocity from intent, lerp `vel` toward it,
    // and integrate. Knockback is added directly and decays.
    const desired = new THREE.Vector3();
    const incapacitated = f.state === 'ko';
    // Charging roots the fighter — all the weight is loaded into the coil.
    const rooted = f.state === 'charge';
    if (intent.move !== 0 && !incapacitated && !rooted) {
      const toward = opp.rig.root.position.clone().sub(pos);
      toward.y = 0;
      if (toward.lengthSq() > 1e-6) toward.normalize();
      // Biden "The Big Guy" slow-on-charge: halved moveMul while the slow
      // window is live. Defaults to 1.0 (no slowdown).
      // JFK "PT-109 Survivor" dash speed boost: +30% for 4 s when below 50%.
      // FDR "Four-Term Foundation" startup boost: +10% for first 3 s.
      const slow = f.slowMul || 1.0;
      let passiveMul = 1.0;
      const per = f.personality;
      if (per?.jfkDashUntil && this.t < per.jfkDashUntil) passiveMul *= 1.30;
      if (per?.fdrStartupUntil && this.t < per.fdrStartupUntil
          && PERSONALITIES.fdr?.startupBoost) {
        passiveMul *= PERSONALITIES.fdr.startupBoost.speedMul || 1.10;
      }
      desired.add(toward.multiplyScalar(intent.move * moveSpeed * effect.moveMul * slow * passiveMul));
      f.speedAmt = Math.min(1, Math.abs(intent.move));
    }
    // Move slowly even in hitstun/attack windup — the player is "shuffling".
    if (f.state === 'hitstun') desired.multiplyScalar(0.2);

    // Lerp velocity toward desired — mass-scaled accel; heavier fighters feel weightier.
    const a = moveAccel * (1 / f.rig.config.mass);
    const k = 1 - Math.exp(-dt * a);
    f.vel.lerp(desired, k);

    // Knockback + sidestep impulses.
    f.knockback.multiplyScalar(Math.max(0, 1 - dt * 8));
    f.sideVel.multiplyScalar(Math.max(0, 1 - dt * 10));
    if (intent.side !== 0 && !incapacitated && !rooted) {
      const camDir = this._sideDirection();
      f.sideVel.add(camDir.multiplyScalar(intent.side * 5.5));
    }

    // Integrate position.
    pos.x += (f.vel.x + f.knockback.x + f.sideVel.x) * dt;
    pos.z += (f.vel.z + f.knockback.z + f.sideVel.z) * dt;

    // ── State machine ────────────────────────────────────────────────
    switch (f.state) {
      case 'idle': {
        // Energy is static while idle — it only moves via winding up (fill) or
        // attacking (empty). No passive regen.
        // A punch needs the striking (right) arm — a fighter that lost it can
        // only kick. Kick input still works with no arms.
        const canPunch = intent.punch && this._canPunch(f);
        if (canPunch || intent.kick) {
          const name = canPunch ? 'punch' : 'kick';
          this._enterCharge(f, name);
          break;
        }
        // Signature super activation: edge-triggered, only from idle so the
        // pose read is clean ("He lines up. He fires."). No-op if the meter
        // isn't full or this fighter has no onSuper config.
        if (intent.super) this._fireSuper(f);
        if (intent.block) {
          f.state = 'block';
          f.animator.setBlocking(true);
        }
        break;
      }
      case 'charge': {
        // Winding up: charge accrues while the button is held (capped at
        // CHARGE_TIME; you can hold at max forever). Release throws the
        // attack scaled by the stored charge.
        const held = f.chargeName === 'punch' ? intent.punchHeld : intent.kickHeld;
        // Holding pumps the shared energy pool; the coil animation shows the
        // TRUE banked power (idle regen + block rewards included), so a
        // fighter who blocked a haymaker coils near-full almost instantly.
        f.energy = Math.min(1, f.energy + dt / CHARGE_TIME);
        f.chargeAmt = f.energy;
        f.animator.setCharge(f.chargeName, f.chargeAmt);
        // Full-charge cue: one audible snap when the coil tops out.
        if (f.chargeAmt >= 1 && !f.chargeCued) {
          f.chargeCued = true;
          this.audio.whoosh();
        }
        // Spark motes at the loaded fist/foot once the charge means something.
        f.chargeSparkT -= dt;
        if (f.chargeAmt > 0.25 && f.chargeSparkT <= 0) {
          f.chargeSparkT = 0.16 - 0.08 * f.chargeAmt;
          const anchor = f.rig.joints[f.chargeName === 'punch' ? 'fistR' : 'footR'];
          if (anchor) {
            const p = new THREE.Vector3();
            anchor.getWorldPosition(p);
            this._spawnSparks(p, 0xffd257, 2, 0.4 + 0.5 * f.chargeAmt);
          }
        }
        if (!held) {
          const amt = f.chargeAmt;
          f.animator.setCharge(null, 0);
          this._enterAttack(f, f.chargeName, amt);
        }
        break;
      }
      case 'block': {
        if (!intent.block) {
          f.state = 'idle';
          f.animator.setBlocking(false);
        }
        break;
      }
      case 'punch':
      case 'kick': {
        const a = ATTACKS[f.state];
        const inActive = f.stateT >= a.windup && f.stateT <= a.windup + a.active;
        if (inActive && !f.hasHit) this._tryHit(f, opp, a);

        // Cancel windows: if the player input another action and we're past the
        // configured stateT threshold for that target, transition immediately.
        // Attack cancels re-enter the charge state so a held follow-up charges too.
        if (intent.punch && this._canPunch(f) && f.stateT >= a.cancelInto.punch) this._enterCharge(f, 'punch');
        else if (intent.kick && f.stateT >= a.cancelInto.kick) this._enterCharge(f, 'kick');
        else if (intent.block && f.stateT >= a.cancelInto.block) {
          f.state = 'block'; f.stateT = 0; f.animator.setBlocking(true);
          this._destroySwingPhysics(f);
        } else if (f.stateT >= a.windup + a.active + a.recover) {
          f.state = 'idle'; f.stateT = 0; f.attack = null;
          this._destroySwingPhysics(f);
        }
        break;
      }
      case 'hitstun': {
        if (f.stateT >= HITSTUN) f.state = 'idle';
        if (f.state === 'idle') this._destroySwingPhysics(f);
        break;
      }
      case 'ko':
        // KO: drop any swing physics so the ragdoll has clean state.
        this._destroySwingPhysics(f);
        break;
    }
  }

  // Start winding an attack up. The fighter is rooted until the button is
  // released (see the 'charge' case in _tickFighter), then _enterAttack
  // throws the strike scaled by the stored charge.
  _enterCharge(f, name) {
    f.state = 'charge';
    f.stateT = 0;
    f.chargeName = name;
    f.chargeAmt = f.energy; // coil starts at the already-banked power
    f.chargeCued = false;
    f.chargeSparkT = 0;
    f.animator.setBlocking(false);
    f.animator.setCharge(name, f.chargeAmt);
    this._destroySwingPhysics(f);
  }

  _enterAttack(f, name, chargeAmt = 0) {
    // A punch needs the striking (right) arm; if it was torn off mid-charge,
    // drop back to idle rather than swinging a missing limb.
    if (name === 'punch' && !this._canPunch(f)) {
      f.state = 'idle';
      f.stateT = 0;
      f.chargeName = null;
      f.animator.setCharge(null, 0);
      return;
    }
    f.state = name;
    f.stateT = 0;
    f.hasHit = false;
    f.attack = ATTACKS[name];
    f.chargeName = null;
    f.chargeMul = 1 + (CHARGE_MAX_MUL - 1) * chargeAmt;
    // Per-swing timing multipliers (Eisenhower "Operation Overlord": 1.5×
    // windup, 0.5× active; cleared at swing completion). Read by _tryHit
    // for the phase boundary check.
    f.swingWindupMul = 1.0;
    f.swingActiveMul = 1.0;
    if (f.personality?.id === 'eisenhower' && PERSONALITIES.eisenhower?.onSwingP) {
      f.swingWindupMul = PERSONALITIES.eisenhower.onSwingP.overWindupMul || 1.0;
      f.swingActiveMul = PERSONALITIES.eisenhower.onSwingP.overActiveMul || 1.0;
    }
    // Spend-it-all: the swing consumes the whole energy pool. Regen crawls
    // back toward the 50% idle cap; blocks are the fast way to reload.
    f.energy = 0;
    this.hudDirty = true;
    f.animator.play(name);

    // ── On-swing personality flags (consumed at hit landing) ─────────
    // Trump "THE WALL" haymaker: 18% of swings commit to a heavy right with
    // 1.5× damage and 1.3× knockback. We tag the swing here; the hit handler
    // multiplies base damage by the mul and clears the flag.
    const per = f.personality;
    if (per?.id === 'trump' && PERSONALITIES.trump?.onSwingP
        && !per._haymakerSuppressedThisSwing
        && this.rng.random() < PERSONALITIES.trump.onSwingP.haymakerChance) {
      f._trumpHaymaker = true;
    }
    // Nixon "Tricky Dick": 25% of swings carry a dirty tag — when the hit
    // is blocked, ~40% of the time the block lets the damage slip through.
    // SUPER override: when "I Am Not a Crook" is active, ALL swings in the
    // remaining counter carry the dirty tag (decays per swing via the
    // superDirtySwingsLeft counter).
    const nixonDirtyChance = per?.id === 'nixon'
      ? (per.superDirtySwingsLeft > 0
          ? 1.0
          : PERSONALITIES.nixon.onSwingP.dirtyChance)
      : 0;
    if (per?.id === 'nixon' && PERSONALITIES.nixon?.onSwingP
        && !f._dirtySwing
        && this.rng.random() < nixonDirtyChance) {
      f._dirtySwing = true;
      if (per.superDirtySwingsLeft > 0) {
        per.superDirtySwingsLeft = Math.max(0, per.superDirtySwingsLeft - 1);
      }
    }
    // Bush Sr. "VOODOO ECONOMICS": next 3 swings after a super each carry
    // 1.4× damage on top of whatever else is going on. The flag flips off
    // one swing at a time.
    if (per?.id === 'bushsr' && per.superPumpSwingsLeft > 0) {
      f._bushsrSuperPump = true;
      per.superPumpSwingsLeft = Math.max(0, per.superPumpSwingsLeft - 1);
    }
    // Ford "Ford Stumble": 15% of swings self-stun for 0.6 s — abort the
    // committed swing mid-air and route the fighter to 'idle' briefly.
    if (per?.id === 'ford' && PERSONALITIES.ford?.onSwingP) {
      const cfg = PERSONALITIES.ford.onSwingP;
      if (this.rng.random() < cfg.stumbleChance) {
        per.stumbleUntil = this.t + cfg.stumbleSelfStunSecs;
        f.state = 'idle';
        f.stateT = 0;
        f.attack = null;
        f.animator.play('stumble');
        return;
      }
    }
    // Trail color: cool steel normally, hot gold on a charged release —
    // "charged" means wound up well past the 1/3 starting bank, so gold still
    // reads as earned bonus power rather than lighting up every tap.
    if (f.trail) f.trail.color.setHex(chargeAmt > 0.65 ? 0xffd257 : 0xcfe0ff);
    this.audio.whoosh();
    // Attack lunge: a real step into the strike, scaled by charge. This is
    // where the "reach" lives now that the hitboxes track the actual limb —
    // a charged release lunges dramatically further.
    const opp = this.fighters.find((o) => o !== f);
    if (opp) {
      const dir = new THREE.Vector3().subVectors(opp.rig.root.position, f.rig.root.position);
      dir.y = 0;
      if (dir.lengthSq() > 1e-6) {
        dir.normalize();
        // FDR "Fireside Chat" reach bonus: his next swing's lunge is scaled
        // by the per-fighter fdrNextSwingReachMul (set during a chat iframe).
        const reachMul = (f.personality?.fdrNextSwingReachMul && f.personality.fdrNextSwingReachMul > 1.0) || 1.0;
        if (reachMul > 1.0) f.personality.fdrNextSwingReachMul = 1.0; // consumed
        const lunge = (name === 'kick' ? 2.2 : 1.8) * (1 + 1.4 * chargeAmt) * reachMul;
        f.knockback.add(dir.multiplyScalar(lunge));
      }
    }
    // Tear down any prior swing physics and build the new striker bodies.
    // These are the cannon-es spheres that actually register hits via
    // the `collide` event during the active window.
    if (f.swingPhysics) destroySwingPhysics(this._physics.world, f.swingPhysics);
    f.swingPhysics = buildSwingPhysics(this._physics.world, this._physics.materials, f, name, 'active');
  }

  _destroySwingPhysics(f) {
    if (f.swingPhysics) {
      destroySwingPhysics(this._physics.world, f.swingPhysics);
      f.swingPhysics = null;
    }
  }

  // Hook cannon's `collide` event so a real physics intersection
  // between a striker sphere and a hurt sphere fires the existing
  // _tryHit pipeline. Registered once on the world; we resolve which
  // fighter owns which body via body.userData.
  _setupPhysicsCollisions() {
    if (!this._physics) return;
    this._physics.world.addEventListener('beginContact', (event) => {
      const a = event.bodyA, b = event.bodyB;
      // A body removed by an earlier event in this same dispatch loop makes
      // cannon's getBodyById return undefined for later pairs.
      if (!a || !b) return;
      const striker = a.userData?.kind === 'striker' ? a
                   : b.userData?.kind === 'striker' ? b : null;
      const hurt = a.userData?.kind === 'hurt' ? a
                 : b.userData?.kind === 'hurt' ? b : null;
      // Two strikers meeting mid-air = a parry clash.
      if (a.userData?.kind === 'striker' && b.userData?.kind === 'striker') {
        this._handleClash(a, b);
        return;
      }
      if (!striker || !hurt) return;
      this._handlePhysicsHit(striker, hurt, event);
    });
  }

  _handlePhysicsHit(strikerBody, hurtBody, event) {
    // Find which fighter owns the striker body.
    const attacker = this.fighters.find((f) =>
      f.swingPhysics && f.swingPhysics.spheres.includes(strikerBody));
    const defender = this.fighters.find((f) =>
      f.fighterPhysics && f.fighterPhysics.hurtSpheres.includes(hurtBody));
    if (!attacker || !defender) return;
    if (attacker === defender) return;
    if (attacker.hasHit) return;
    if (attacker.state !== 'punch' && attacker.state !== 'kick') return;

    // Recoil on the striker — visible "fist bounced off body" feedback.
    const normal = event.contact?.ni ?? { x: 0, z: 1 };
    applyRecoil(strikerBody, normal);

    // Trigger the existing _tryHit pipeline so damage / knockback / sparks
    // / KO all run with the same logic as before. The cannon contact normal
    // and striker velocity ride along so the reaction springs whip in the
    // ACTUAL direction of the blow.
    const attack = ATTACKS[attacker.state];
    this._tryHit(attacker, defender, attack, {
      normal: { x: normal.x, y: normal.y ?? 0, z: normal.z },
      strikerVel: strikerBody.velocity
        ? { x: strikerBody.velocity.x, y: strikerBody.velocity.y, z: strikerBody.velocity.z }
        : null,
    });
  }

  // Striker-vs-striker contact: both fighters threw at once and the limbs
  // met mid-air. Resolved as an elastic clash — both rebound by mass ratio,
  // neither strike lands, big spark flash and double hitstop.
  _handleClash(bodyA, bodyB) {
    if (this._clashCooldown > 0) return;
    const fa = this.fighters.find((f) => f.swingPhysics && f.swingPhysics.spheres.includes(bodyA));
    const fb = this.fighters.find((f) => f.swingPhysics && f.swingPhysics.spheres.includes(bodyB));
    if (!fa || !fb || fa === fb) return;
    const inActive = (f) => f.attack && (f.state === 'punch' || f.state === 'kick')
      && f.stateT <= f.attack.windup + f.attack.active + 0.04;
    if (!inActive(fa) || !inActive(fb)) return;
    this._clashCooldown = 0.35;

    // Neither strike lands out of this swing — the clash IS the resolution.
    fa.hasHit = true;
    fb.hasHit = true;

    const mid = new THREE.Vector3(
      (bodyA.position.x + bodyB.position.x) / 2,
      (bodyA.position.y + bodyB.position.y) / 2,
      (bodyA.position.z + bodyB.position.z) / 2);
    for (const [f, o] of [[fa, fb], [fb, fa]]) {
      const away = new THREE.Vector3()
        .subVectors(f.rig.root.position, o.rig.root.position);
      away.y = 0;
      if (away.lengthSq() > 1e-6) away.normalize(); else away.set(1, 0, 0);
      // Elastic rebound scaled by the OTHER fighter's mass.
      f.knockback.add(away.multiplyScalar(2.6 * (o.rig.config.mass / f.rig.config.mass)));
      f.animator.applyReaction('shoulderR', 5, 0, -4);
      f.animator.applyReaction('elbowR', -7, 0, 0);
      f.animator.applyReaction('torso', -2, 0, 0);
    }
    this._spawnSparks(new THREE.Vector3(mid.x, mid.y - 1.0, mid.z), 0xfff2c0, 14, 1.8);
    this._flashImpactLight(mid, 12, 0xfff2c0, 0.2);
    this.hitstopT = 6 * SIM_DT;
    this.shakeT = 0.16;
    this.shakeAmp = 0.1;
    // Radial streak on a block removed 2026-08-07 alongside the per-hit pulses
    // in _hitFeedback — blocks come in bursts too, so this was the same flicker.
    // Chromatic-aberration colour pulse removed per user request.
    this.audio.block(mid);
    this.excited = Math.max(this.excited, 0.5);
  }

  // Route a world-space impulse direction into the struck region's reaction
  // springs. The direction is converted to the defender's root-local frame:
  // local +Z = the blow came from the front (whip backward, −rot.x), local
  // ±X = lateral (roll/turn the region away). Magnitudes stay in the same
  // band the old hand-tuned constants used; only the DIRECTION is now real.
  _applyImpulseReactions(defender, region, rSide, impulseDir, rPow) {
    const yaw = defender.rig.root.rotation.y;
    // World → defender-local (rotate by −yaw about Y). Defender faces +Z
    // locally, so a blow arriving along its facing has local z ≈ −1.
    _impLocal.set(
      impulseDir.x * Math.cos(-yaw) - impulseDir.z * Math.sin(-yaw),
      impulseDir.y,
      impulseDir.x * Math.sin(-yaw) + impulseDir.z * Math.cos(-yaw));
    const lx = _impLocal.x, lz = _impLocal.z;
    const anim = defender.animator;
    if (region === REGIONS.HEAD) {
      anim.applyReaction('head', 5 * rPow * lz, 4 * rPow * lx, -3 * rPow * lx);
      anim.applyReaction('torso', 1.2 * rPow * lz, 0, -1 * rPow * lx);
    } else if (region === REGIONS.TORSO) {
      anim.applyReaction('torso', 2 * rPow * lz, 0, -1.5 * rPow * lx);
      anim.applyReaction('head', 1.8 * rPow * lz, 0, 0);
      anim.applyReaction('shoulderL', 0, 0, 2.5 * rPow);
      anim.applyReaction('shoulderR', 0, 0, -2.5 * rPow);
    } else if (region === REGIONS.ARMS && rSide) {
      anim.applyReaction('shoulder' + rSide, 3 * rPow * lz, 0, 5 * rPow * lx);
      anim.applyReaction('elbow' + rSide, -5 * rPow, 0, 0);
    } else if (region === REGIONS.LEGS && rSide) {
      anim.applyReaction('hip' + rSide, 3 * rPow * lz, 0, 2 * rPow * lx);
      anim.applyReaction('knee' + rSide, 5 * rPow, 0, 0); // buckle
    }
  }

  // ── Personality helpers ────────────────────────────────────────────
  // On every fighter tick the engine checks trigger-once thresholds
  // (Reagan at <25% HP → Morning in America, W Bush at <40% → Decider,
  // Carter at <30% → Malaise Speech iframes, W Bush/Nixon once-per-round
  // flags), and clears expired modes.
  _tickPersonalities(f, dt) {
    if (!f.personality) return;
    const per = f.personality;
    const hpFrac = f.hpCur / MAX_HP;
    const now = this.t;

    // FDR "Four-Term Foundation" startup boost — armed on the first personality
    // tick of the round (once per fighter; gated by a flag). Fires for the
    // first `durationSecs` seconds of the match.
    if (f.charId === 'fdr' && PERSONALITIES.fdr?.startupBoost
        && !per._fdrStartupArmed) {
      per._fdrStartupArmed = true;
      per.fdrStartupUntil = now + (PERSONALITIES.fdr.startupBoost.durationSecs || 3.0);
      per.activeMode = 'fourTerm';
    }

    // Mode expiration.
    if (per.activeMode && per.modeExpiresAt && now >= per.modeExpiresAt) {
      per.activeMode = null;
      per.modeExpiresAt = 0;
    }

    // Trigger-once per round for character modes.
    const prof = per.profile;
    if (!per.triggerFired) {
      if (prof?.triggerOnce && prof.checkHpBelow != null && hpFrac <= prof.checkHpBelow) {
        per.triggerFired = true;
        if (prof.onTrigger === 'decider') {
          // W Bush: 1.5 s freeze window, then +40% dmg + 15% speed for rest
          // of round. We approximate the freeze by sticking him in 'idle'
          // for 1.5 s while his intent-to-attack dominates.
          per.activeMode = 'decider';
          // Use the timestep + 8 s so mode=decider is sticky for the match.
          per.modeExpiresAt = now + (prof.onTriggerParams?.durationSecs || 30);
          // The "freeze" portion is realized by delaying the first post-
          // decider attack: pause his controller for 1.5 s.
          if (f.controller && f.controller.__proto__?.constructor?.name === 'AiController') {
            f.controller.__freezeUntil = now + (prof.onTriggerParams?.freezeSecs || 1.5);
          } else if (f.controller) {
            f.controller.__freezeUntil = now + (prof.onTriggerParams?.freezeSecs || 1.5);
          }
          f.animator.play('salute'); // visual cue — decider "stops to think"
        } else if (prof.onTrigger === 'morningInAmerica') {
          per.activeMode = 'morningInAmerica';
          per.modeExpiresAt = now + (prof.onTriggerParams?.durationSecs || 6);
        } else if (prof.onTrigger === 'malaiseSpeech') {
          per.iframesUntil = now + (prof.onTriggerParams?.iframesSecs || 1.5);
          per.activeMode = 'malaiseSpeech';
          per.modeExpiresAt = now + (prof.onTriggerParams?.iframesSecs || 1.5);
        }
      }
    }

    // Slow effect clears.
    if (per.slowUntil && now >= per.slowUntil) {
      per.slowUntil = 0;
      f.slowMul = 1.0;
    }

    // ── FDR "Four-Term Foundation" startup boost ────────────────────
    // First 3 s of a match, FDR has +10% speed and +10% dmg. The engine
    // clears the boost when the timer expires.
    if (per.fdrStartupUntil) {
      if (now >= per.fdrStartupUntil) {
        per.fdrStartupUntil = 0;
        per.activeMode = null;
      } else if (!per.activeMode) {
        per.activeMode = 'fourTerm';
      }
    }
    // JFK "PT-109 Survivor" dash clear.
    if (per.jfkDashUntil && now >= per.jfkDashUntil) per.jfkDashUntil = 0;

    // Eisenhower "Atoms for Peace" iframes clear.
    if (per.eisenhowerIframesUntil && now >= per.eisenhowerIframesUntil) {
      per.eisenhowerIframesUntil = 0;
    }
    // JFK profile-iframes clear.
    if (per.jfkProfileIframesUntil && now >= per.jfkProfileIframesUntil) {
      per.jfkProfileIframesUntil = 0;
    }
    // FDR periodic iframes ("Fireside Chat") fire every ~6 s.
    if (per.fdrIframesUntil && now >= per.fdrIframesUntil) {
      per.fdrIframesUntil = 0;
    }
    // Periodic iframes schedule.
    if (PERSONALITIES.fdr?.periodicIframes && !per.fdrIframesUntil
        && per.fdrPeriodicReady === undefined) {
      per.fdrPeriodicReady = now + (PERSONALITIES.fdr.periodicIframes.everySecs || 6) - 1.5;
    }
    if (per.fdrPeriodicReady !== undefined && now >= per.fdrPeriodicReady
        && PERSONALITIES.fdr?.periodicIframes && f.charId === 'fdr') {
      per.fdrIframesUntil = now + (PERSONALITIES.fdr.periodicIframes.iframesSecs || 0.4);
      per.fdrNextSwingReachMul = PERSONALITIES.fdr.periodicIframes.nextSwingReachMul || 1.25;
      per.fdrPeriodicReady = now + (PERSONALITIES.fdr.periodicIframes.everySecs || 6);
    }

    // Truman "Buck Stops Here" stack decay (50% of a stack per sec without
    // being hit — represented as a half-life approximately every 1.4 s).
    if (PERSONALITIES.truman?.stacksOnHit && per.trumanBuckStacks > 0) {
      const cur = per.trumanBuckStacks;
      per.trumanBuckStacks = Math.max(0,
        cur - (PERSONALITIES.truman.stacksOnHit.decayPerSec || 0.5) * dt);
    }

    // ── Eisenhower & JFK HP-gated modes (PT-109 / Atoms for Peace / Day of Infamy)
    if (prof?.triggerHpGated && !per._hpTriggeredByKey) per._hpTriggeredByKey = {};
    if (prof?.triggerHpGated) {
      const tg = prof.triggerHpGated;
      const opp = this.fighters.find((o) => o !== f);
      const oppHp = opp?.hpCur ?? 100;
      const myHpFrac = f.hpCur / MAX_HP;
      if (!per._hpTriggeredByKey[tg.modeName]) {
        let fire = false;
        if (tg.checkHpBelow != null && myHpFrac <= tg.checkHpBelow) fire = true;
        if (tg.checkHpAboveOpp != null
            && (myHpFrac - oppHp / MAX_HP) >= tg.checkHpAboveOpp) fire = true;
        if (fire) {
          per._hpTriggeredByKey[tg.modeName] = true;
          if (tg.modeName === 'pt109Dash') {
            per.jfkDashUntil = now + (tg.durationSecs || 4.0);
            per.jfkDashCooldownUntil = now + (tg.cooldownSecs || 6.0);
          } else if (tg.modeName === 'atomsForPeace') {
            per.eisenhowerIframesUntil = now + (tg.iframesSecs || 1.0);
            per.eisenhowerNextSwingAtkMul = tg.nextSwingAtkMul || 1.20;
          } else if (tg.modeName === 'dayOfInfamy') {
            per.activeMode = tg.modeName;
            per.modeExpiresAt = now + (tg.durationSecs || 5.0);
          }
        }
      }
    }
    // JFK profile-iframes: time-gated, fires at triggerT seconds into the
    // match (single fire). Used for "Profiles in Courage".
    if (prof?.triggerT !== undefined && !per._timeTriggered
        && this.t >= prof.triggerT) {
      per._timeTriggered = true;
      if (prof.onTrigger === 'profilesInCourage') {
        const params = prof.onTriggerParams || {};
        per.jfkProfileIframesUntil = now + (params.iframesSecs || 0.45);
        per.jfkNextSwingAtkMul = params.nextSwingAtkMul || 1.25;
      }
    }
  }

  // ── SUPER METER ────────────────────────────────────────────────────────
  // The comeback super meter is a per-fighter 0..1 pool that fills passively
  // by taking damage (see the damage roll in _tryHit). When ≥ 1.0 the player
  // can press their Super key (or, for the AI, the controller emits
  // `intent.super = true` after the AI's gating checks). Firing calls
  // `_fireSuper`, which:
  //   1. consumes the meter to zero (one-shot),
  //   2. routes through PERSONALITIES[id].onSuper to set the right runtime
  //      fields (mode, iframes, dirty count, swing bonus, etc.),
  //   3. emits a screen-wide flash + camera pulse + audio cue for impact.
  //
  // The meter is intentionally NOT fueled by dealing damage: the design is a
  // comeback mechanic — you earn the super by being on the wrong end of a
  // beatdown, so the burst is the response that turns the round around.
  //
  // Per-frame: nothing happens unless the meter just hit 1.0, in which case
  // we set superUntil = now + 1.6 s — the HUD reads it as the "PRESS SUPER"
  // flash window. We don't tick down the meter otherwise; it stays at 1.0
  // until consumed by a fire (or reset on round reset).
  _tickSuperMeter(f, opp, dt) {
    const per = f.personality;
    if (!per) return;
    // Cap at 1.0 — the meter is binary "ready or not".
    if (per.superMeter > 1.0) per.superMeter = 1.0;
    if (per.superMeter >= 1.0 && this.t > (per.superUntil || 0)) {
      per.superUntil = this.t + 1.6;
    }
    // Defensive: if the personality has no onSuper config, never let the
    // meter fill past 0 — the player shouldn't see a "press super" prompt
    // that does nothing.
    if (!PERSONALITIES[f.charId]?.onSuper) per.superMeter = 0;
  }

  // Fire the fighter's signature super. Called from _tickFighter on a
  // super-intent edge in the idle state, OR from the AI controller's
  // super-activation block via the same intent. Always called with meter
  // ≥ 1.0 — if not, this is a no-op.
  _fireSuper(f) {
    const per = f.personality;
    const cfg = PERSONALITIES[f.charId]?.onSuper;
    if (!per || !cfg || per.superMeter < 1.0) return;
    // Consume the meter regardless of fill level — one-shot, intentionally
    // not "spend only what you need". This rewards timing over hoarding.
    per.superMeter = 0;
    per.superActiveMode = cfg.mode;
    per.superFiredAt = this.t;
    // Apply the per-mode effects via a small switch. Each block writes the
    // runtime fields the existing damage / hit / tick code paths already
    // consult (activeMode, modeExpiresAt, iframesUntil, superSwingAtkMul,
    // superDirtySwingsLeft, superPumpSwingsLeft, lbjMissKBUntil, etc.).
    this._applySuperEffect(f, cfg);
    // ── Feedback ────────────────────────────────────────────────────────
    // Camera pulse (handled via exposurePulse, which is read every frame in
    // _updateEffects) and a full-screen flash overlay. Audio cue is a quick
    // rising whoosh — the existing audio.whoosh() is too generic; we use a
    // dedicated gain via audio.bigWhoosh() if present, fall back to whoosh.
    this.exposurePulse = Math.max(this.exposurePulse || 0, 0.55);
    this.hitstopT = Math.max(this.hitstopT || 0, 0.18);
    if (this.flash) {
      this.flash.style.transition = 'opacity 0.05s linear';
      this.flash.style.background = 'rgba(255, 240, 200, 0.55)';
      this.flash.style.opacity = '1';
      setTimeout(() => {
        if (this.flash) {
          this.flash.style.transition = 'opacity 0.45s ease-out';
          this.flash.style.opacity = '0';
        }
      }, 60);
    }
    if (this.audio) this.audio.whoosh?.();
  }

  // Per-mode super effect applier. Reads PERSONALITIES[id].onSuper and writes
  // the corresponding runtime fields consumed by the existing engine paths.
  // Each block is a single switch arm so adding a new personality's super is
  // a one-arm change here + one onSuper config block in personalities.js.
  _applySuperEffect(f, cfg) {
    const per = f.personality;
    const opp = this.fighters.find((o) => o !== f);
    if (!per) return;
    switch (cfg.mode) {
      case 'theWall': {
        // Trump: stack ramp for 3 s.
        per.activeMode = 'theWallSuper';
        per.modeExpiresAt = this.t + (cfg.durationSecs || 3.0);
        // Inline ramp: superSwingAtkMul gets set on every swing commit while
        // active, so we only need a flag here. The damage roll multiplies by
        // (1 + koStacks × 0.05) via the existing per-stack path.
        break;
      }
      case 'bigGuy': {
        // Biden: auto-fill energy to max + auto-arm next swing for lockSecs.
        f.energy = 1.0;
        f.chargeAmt = 1.0;
        // Clear the existing _enterCharge cooldown by entering charge state
        // directly if the player presses punch/kick within the lock window.
        per._bigGuyLockUntil = this.t + (cfg.lockSecs || 1.5);
        break;
      }
      case 'droneStrike': {
        // Obama: iframes + next swing atkMul.
        per.iframesUntil = this.t + (cfg.iframesSecs || 1.5);
        per.superSwingAtkMul = cfg.nextSwingAtkMul || 2.5;
        break;
      }
      case 'deciderManual': {
        // Bush: same as the passive HP-gated mode but no freeze window.
        per.activeMode = 'decider';
        per.modeExpiresAt = this.t + (cfg.durationSecs || 30);
        // Note: the freeze window is what the AI controller's __freezeUntil
        // would normally trigger; we deliberately skip it on the manual path
        // so the human player gets the buff the instant they press the key.
        break;
      }
      case 'saxSolo': {
        // Clinton: arms a one-shot 1.6× next-swing + auto chain. The chain
        // arms via the existing clinton onHitChain handler — we only need to
        // raise the atkMul here and bias the next swing's windup longer.
        per.superSwingAtkMul = cfg.nextSwingAtkMul || 1.6;
        per._saxSoloUntil = this.t + 1.2;
        break;
      }
      case 'voodoo': {
        // Bush Sr.: 3 voodoo-tax swings. The flag is decremented per swing
        // in _enterAttack.
        per.superPumpSwingsLeft = cfg.swingCount || 3;
        break;
      }
      case 'morningInAmerica': {
        // Reagan: +40% dmg + 20% speed for the configured duration.
        per.activeMode = 'morningInAmerica';
        per.modeExpiresAt = this.t + (cfg.durationSecs || 6);
        break;
      }
      case 'malaiseSpeech': {
        // Carter: iframes + next-hit slow (the slow is applied in
        // _applyOnHitPersonalities when this mode is the superActiveMode).
        per.iframesUntil = this.t + (cfg.iframesSecs || 1.5);
        break;
      }
      case 'pardonMe': {
        // Ford: opponent input-blind. Applied directly on the opponent's
        // fighter object (mirrors Nixon's existing eye-gouge path).
        if (opp) {
          opp._inputBlindUntil = this.t + (cfg.blindSecs || 1.0);
          opp._inputBlindMissRate = cfg.blindMissRate || 0.60;
        }
        break;
      }
      case 'notACrook': {
        // Nixon: N dirty swings + first one blinds on hit.
        per.superDirtySwingsLeft = cfg.dirtySwings || 3;
        per._notACrookFirst = true;
        break;
      }
      case 'treatmentManual': {
        // LBJ: arm a long miss-charge window the player picks the moment of.
        per.lbjMissKBUntil = this.t + (cfg.windowSecs || 8.0);
        break;
      }
      case 'profilesInCourage': {
        // JFK: iframes + next-swing bonus. The manual super is larger than
        // the time-gated passive (0.6 s / 1.5× vs 0.45 s / 1.25×).
        per.jfkProfileIframesUntil = this.t + (cfg.iframesSecs || 0.6);
        per.jfkNextSwingAtkMul = cfg.nextSwingAtkMul || 1.5;
        break;
      }
      case 'overlord': {
        // Eisenhower: 2.2× next swing + 1 s iframes.
        per.superSwingAtkMul = cfg.nextSwingAtkMul || 2.2;
        per.eisenhowerIframesUntil = this.t + (cfg.iframesSecs || 1.0);
        break;
      }
      case 'buckStopsHere': {
        // Truman: triple the current buckStacks for the next swing. Clear
        // stacks after so the player doesn't double-dip.
        const mul = cfg.stackMul || 3.0;
        per.superSwingAtkMul = 1.0 + (per.trumanBuckStacks || 0) * 0.02 * mul;
        per.trumanBuckStacks = 0;
        break;
      }
      case 'dayOfInfamy': {
        // FDR: longer-than-passive +35% dmg buff, no HP gate.
        per.activeMode = 'dayOfInfamy';
        per.modeExpiresAt = this.t + (cfg.durationSecs || 8.0);
        break;
      }
      default:
        // Unknown mode: silently ignore (shouldn't happen — PERSONALITIES
        // controls the dispatch).
        break;
    }
  }

  // Resolve per-hit personality effects: Biden slow-on-charge, Clinton elbow
  // flourish scheduling, Reagan/Bush damage multipliers (already applied in
  // the baseDmg block above), Ford retaliate rollover when Ford is hit during
  // his stumble, Nixon eye-gouge proc.
  _applyOnHitPersonalities(attacker, defender, region, baseDmg, hit, attack) {
    const att = attacker.personality;
    const def = defender.personality;
    const now = this.t;
    // Accumulated damage multiplier for the new president layer (LBJ pump,
    // JFK Camelot Glint, Truman Buck Stops Here, FDR day/speed). Returned
    // so the caller can multiply baseDmg just before the damage roll.
    let personalityDmgMul = 1.0;

    // Biden "The Big Guy": when his charged attack lands, apply a 1.0 s moveMul
    // drop on the defender. The biden config sets chargeMul heavily on the
    // tag-detection side; we just check chargeMul > 1 as a proxy.
    if (att?.id === 'biden' && PERSONALITIES.biden?.onChargeHitEffect
        && attacker.chargeMul > 1.0) {
      const params = PERSONALITIES.biden.onHitEffectParams;
      defender.slowUntil = now + (params?.slowSecs || 1.0);
      defender.slowMul = params?.slowMul || 0.5;
    }

    // Bush Sr. "VOODOO ECONOMICS" super: the swing carried a voodoo-tax tag
    // — multiply this hit's damage by the voodoo mul. The swing counter was
    // decremented at swing commit, so we just consult the flag here.
    if (attacker._bushsrSuperPump && att?.id === 'bushsr') {
      const cfg = PERSONALITIES.bushsr?.onSuper;
      personalityDmgMul *= (cfg?.swingAtkMul || 1.4);
      attacker._bushsrSuperPump = false;
    }
    // Trump "THE WALL" super: koStacks ramp is folded into the personality
    // dmgMul above for the next 3 s. (No additional action needed here —
    // superSwingAtkMul = (1 + koStacks × 0.05) was set in _fireSuper.)
    // Carter "MALAISE SPEECH" super: on a landed hit during the window, apply
    // a brief slow on the defender. The iframes are consumed at hit-resolution
    // time via the existing perPer?.iframesUntil check.
    if (att?.superActiveMode === 'malaiseSpeech' && att?.superFiredAt
        && now - att.superFiredAt < (PERSONALITIES.carter.onSuper.slowSecs || 0.5)) {
      defender.slowUntil = now + (PERSONALITIES.carter.onSuper.slowSecs || 0.5);
      defender.slowMul = PERSONALITIES.carter.onSuper.slowMul || 0.55;
    }

    // Clinton "I Feel Your Pain": on a Clinton landed hit, queue follow-up
    // elbow jabs (1 + chained hits scaled by sax-solo counter). The simplest
    // realization is rapid extra damage ticks on a short timer. For the first
    // pass, we add a single extra damage tick to keep the budget down.
    if (att?.id === 'clinton') {
      const flourish = PERSONALITIES.clinton?.onHitChain;
      if (flourish && attack.name === 'punch') {
        const extra = Math.min(flourish.growthCap, flourish.hits + att.saxSinceMiss);
        // Schedule staggered extra damage ticks: 2 more ~50 damage hits over
        // the next 0.45 s.
        this._scheduleClintonFlourish(attacker, defender, extra, hit);
      }
    }

    // Carter "Habitat for Humanity": each landed personal hit bumps the combo
    // ladder; resets after 3 s of no-hit time.
    if (att?.id === 'carter' && PERSONALITIES.carter?.passive
        && PERSONALITIES.carter.passive.name === 'habitatForHumanity') {
      att.habitatComboN = Math.min(
        PERSONALITIES.carter.passive.comboLadderMax,
        att.habitatComboN + 1);
      att.habitatComboT = now;
    }

    // Ford retaliate window opens if defender hits Ford during his stumble.
    if (def?.id === 'ford' && now < def.stumbleUntil) {
      def.retaliateUntil = now + (PERSONALITIES.ford?.onStumbleHit?.retaliateSecs || 1.5);
    }

    // Nixon "I Am Not a Crook": once-per-round eye-gouge on a landed dirty
    // hit. The dirty tag may already have been cleared above, so we use the
    // base "dirty swing" RNG pool instead of a flag.
    if (att?.id === 'nixon' && PERSONALITIES.nixon?.oncePerRound
        && !att.usedThisRound
        && baseDmg > 0) {
      att.usedThisRound = true;
      const cfg = PERSONALITIES.nixon.oncePerRound;
      if (this.rng.random() < cfg.procChance) {
        this._scheduleNixonBlind(defender);
      }
    }

    // ── LBJ "The Johnson Treatment" — armed on swing commit (see _enterAttack)
    // The swing tag we set there is consumed below in the baseDmg block; here
    // we just clean up the timer if it has expired.
    if (att?.lbjMissKBUntil && now >= att.lbjMissKBUntil) att.lbjMissKBUntil = 0;

    // ── LBJ "All the Way with LBJ": on first landed hit per round, arm 3
    // swings with +20% dmg.
    if (att?.id === 'lbj' && PERSONALITIES.lbj?.oncePerRound
        && !att.usedThisRound && baseDmg > 0) {
      att.usedThisRound = true;
      const cfg = PERSONALITIES.lbj.oncePerRound;
      att.lbjPumpSwingsLeft = cfg.pumpSwingCount || 3;
    }
    if (att?.id === 'lbj' && att.lbjPumpSwingsLeft > 0 && baseDmg > 0) {
      att.lbjPumpSwingsLeft -= 1;
      personalityDmgMul *= PERSONALITIES.lbj.oncePerRound.pumpAtkMul || 1.20;
    }

    // ── JFK "Camelot Glint": every Nth landed swing gets a 1.4× mul.
    if (att?.id === 'jfk' && PERSONALITIES.jfk?.everyNthHit && baseDmg > 0) {
      att.jfkDashboardCount = (att.jfkDashboardCount || 0) + 1;
      if (att.jfkDashboardCount
          >= (PERSONALITIES.jfk.everyNthHit.n || 4)) {
        att.jfkDashboardCount = 0;
        personalityDmgMul *= PERSONALITIES.jfk.everyNthHit.mul || 1.4;
      }
    }
    // JFK "Profiles in Courage" next-swing bonus cleared on first hit.
    if (att?.id === 'jfk' && att.jfkNextSwingAtkMul > 1.0 && baseDmg > 0) {
      personalityDmgMul *= att.jfkNextSwingAtkMul;
      att.jfkNextSwingAtkMul = 1.0;
    }
    // Eisenhower next-swing bonus cleared on first hit.
    if (att?.id === 'eisenhower' && att.eisenhowerNextSwingAtkMul > 1.0
        && baseDmg > 0) {
      personalityDmgMul *= att.eisenhowerNextSwingAtkMul;
      att.eisenhowerNextSwingAtkMul = 1.0;
    }

    // ── Truman "Buck Stops Here" accumulator — applied to the ATTACKER
    // when he lands (each swing longer-sustains the bonus), OR to him when
    // he's hit and racks it. Simplest realization: the swing-time dmg scales
    // with the stack count.
    if (att?.id === 'truman' && PERSONALITIES.truman?.stacksOnHit
        && baseDmg > 0) {
      const cfg = PERSONALITIES.truman.stacksOnHit;
      const stacks = att.trumanBuckStacks || 0;
      const incMul = 1 + stacks * (cfg.dmgPerStack || 0.02);
      personalityDmgMul *= incMul;
    }
    // Award Truman a stack ON DEFENSE: every successful hit taken bumps
    // his stack counter (until capped).
    if (def?.id === 'truman' && PERSONALITIES.truman?.stacksOnHit
        && baseDmg > 0) {
      def.trumanBuckStacks = Math.min(
        PERSONALITIES.truman.stacksOnHit.cap || 30,
        (def.trumanBuckStacks || 0) + 1);
    }

    // ── FDR "Four-Term Foundation" startup boost → damage mul.
    if (att?.id === 'fdr' && att.fdrStartupUntil && now < att.fdrStartupUntil
        && PERSONALITIES.fdr?.startupBoost) {
      personalityDmgMul *= PERSONALITIES.fdr.startupBoost.atkMul || 1.10;
    }
    // ── FDR "Day of Infamy" (already in activeMode 'dayOfInfamy'). ──
    if (att?.activeMode === 'dayOfInfamy'
        && PERSONALITIES.fdr?.triggerHpGated?.atkMul) {
      personalityDmgMul *= PERSONALITIES.fdr.triggerHpGated.atkMul;
    }

    return personalityDmgMul;
  }

  // Schedule Clinton's "I Feel Your Pain" elbow flurry: 2 extra damage ticks
  // over ~0.45 s. Tracks the pending follow-ups on the fighter.
  _scheduleClintonFlourish(attacker, defender, extraCount, refHit) {
    if (!attacker._clintonFlourish) attacker._clintonFlourish = [];
    // Cap pending to avoid runaway stacks.
    if (attacker._clintonFlourish.length >= 6) return;
    attacker._clintonFlourish.push({
      target: defender.playerId,
      damage: 3,                 // 3 dmg per elbow follow-up
      at: this.t + 0.18 * (attacker._clintonFlourish.length + 1),
      leashed: true,
    });
  }

  // Nixon eye-gouge: 0.3 s blind window where the player block presses drop
  // 30% of the time. Realized as a per-frame flag on the defender that's read
  // by the KeyboardController.
  _scheduleNixonBlind(target) {
    const fighter = this.fighters.find((f) => f.playerId === target);
    if (!fighter) return;
    fighter._inputBlindUntil = this.t + 0.30;
  }

  // Clinton follow-up ticks: process each one when due.
  _tickClintonFlourish(f, dt) {
    if (!f._clintonFlourish || !f._clintonFlourish.length) return;
    const now = this.t;
    const opp = this.fighters.find((o) => o !== f);
    for (let i = f._clintonFlourish.length - 1; i >= 0; i--) {
      const p = f._clintonFlourish[i];
      if (now < p.at) continue;
      // Landed: apply minor damage + brief pause frame. Only applies while
      // both fighters are still upright in range.
      if (opp && opp.state !== 'ko' && f.state !== 'ko') {
        const dist = f.rig.root.position.distanceTo(opp.rig.root.position);
        if (dist < 2.5) this.combat.damage({ playerId: p.target, amount: p.damage, sourceId: f.playerId });
      }
      f._clintonFlourish.splice(i, 1);
    }
  }

  _sideDirection() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.y = 0;
    return dir.lengthSq() > 1e-6 ? dir.normalize() : new THREE.Vector3(0, 0, -1);
  }

  _tryHit(attacker, defender, attack, contact = null) {
    // Capsule-vs-capsule polygon hit detection. We test the attacker's
    // striker capsules (punch = right arm + fist, kick = right leg + foot)
    // against the defender's full body hurt set. A hit is registered only
    // when at least one striker/hurt capsule pair intersects; the deepest
    // intersection wins for both location and region.
    // A KO'd body is invulnerable — wailing on a ragdoll would read as
    // unfair and looks broken.
    if (defender.state === 'ko') return;

    // Phase detection honors per-fighter swing timing multipliers (Eisenhower
    // "Overlord" stretches windup and compresses active). windup and active
    // boundaries scale with the fighter's swingWindupMul / swingActiveMul.
    const wMul = attacker.swingWindupMul ?? 1.0;
    const aMul = attacker.swingActiveMul ?? 1.0;
    const phase = (attacker.stateT > attack.windup * wMul + attack.active * aMul)
      ? 'recover' : 'active';
    let hit = testAttackHit(attacker.rig, attack.name, phase, defender.rig);
    // ── Obama "no-drama open" passive dodge ──────────────────────────
    // ~22% of incoming attacks simply miss against Obama — a casual lean
    // that the engine realizes as a hit-test miss returning false.
    if (hit && defender.personality?.id === 'obama'
        && PERSONALITIES.obama?.passiveDodgeChance
        && this.rng.random() < PERSONALITIES.obama.passiveDodgeChance) {
      hit = null;
    }
    if (!hit) {
      // ── LBJ "The Johnson Treatment" — opponent missed in range ─────
      // Whenever the swinging fighter MISSES in range and the OPPONENT is
      // LBJ, arm LBJ's "Treatment" knockback bonus for the next 3.5 s.
      // The enginner intent-wise reads the defender (potential LBJ) and
      // checks the in-range predicate; if so, flag the knockback window.
      if (defender?.personality?.id === 'lbj'
          && PERSONALITIES.lbj?.onOpponentMissCharge) {
        const lpos = defender.rig.root.position;
        const apos = attacker.rig.root.position;
        const d = Math.hypot(lpos.x - apos.x, lpos.z - apos.z);
        if (d < 2.4) {
          defender.personality.lbjMissKBUntil = this.t
            + (PERSONALITIES.lbj.onOpponentMissCharge.expiresSecs || 3.5);
        }
      }
      return;
    }

    attacker.hasHit = true;
    const dpos = defender.rig.root.position;
    const apos = attacker.rig.root.position;
    const knockDir = new THREE.Vector3(dpos.x - apos.x, 0, dpos.z - apos.z);
    if (knockDir.lengthSq() > 1e-6) knockDir.normalize(); else knockDir.set(1, 0, 0);

    // Real impulse direction: cannon's contact normal (sign-aligned so it
    // always points INTO the defender), falling back to root-to-root when
    // the hit came through the capsule tester without a physics contact.
    const impulseDir = new THREE.Vector3();
    if (contact && contact.normal) {
      impulseDir.set(contact.normal.x, contact.normal.y, contact.normal.z);
      if (impulseDir.lengthSq() < 1e-6) impulseDir.copy(knockDir);
      else if (impulseDir.dot(knockDir) < 0) impulseDir.negate();
      impulseDir.normalize();
    } else {
      impulseDir.copy(knockDir);
    }

    // ── Mass-scaled knockback & visual lean ──────────────────────────
    const atkMass = attacker.rig.config.mass;
    const defMass = defender.rig.config.mass;
    const powerScale = attacker.rig.config.attackPower * (atkMass / defMass);
    const effect = regionEffect(defender.regionDmg);

    // Region classifier — driven by which hurt capsule was actually
    // touched, not a Y-band heuristic. This is the whole point of the
    // polygon hitbox: a fist on the forearm hits "arms", not "torso".
    const region = regionForHurtBone(hit.capsule);
    const regionMod = region === REGIONS.HEAD ? 1.25
                    : region === REGIONS.LEGS ? 0.85
                    : 1.0;

    // If the defender is blocking, only the guard capsules count — the hurt
    // capsules still register the "near-miss" but the striker must explicitly
    // touch the guard surface to count as blocked.
    const chargeMul = attacker.chargeMul || 1;
    let blocked = defender.state === 'block' &&
                  testAttackBlocked(attacker.rig, attack.name, phase, defender.rig);
    // ── Nixon "Tricky Dick": 25% of attacks carry a dirty tag ────────
    // When dirty is set on the swing commit, ~40% of the time the block
    // simply slips — the swing connects through as if no guard were up.
    if (attacker._dirtySwing) {
      const dirtyCfg = PERSONALITIES.nixon?.onSwingP;
      if (dirtyCfg && this.rng.random() < dirtyCfg.dirtyBlockFraction) blocked = false;
      attacker._dirtySwing = false;
    }
    if (blocked) {
      // Blocking no longer banks energy (the bar only moves via winding up /
      // attacking), but a clean block still absorbs the blow.
      const blockDamp = 1 / defMass;
      defender.knockback.add(knockDir.clone().multiplyScalar(2.0 * blockDamp * chargeMul));
      this._spawnSparks(hit.point, 0x9ad0ff, 6, 1.0);
      this._flashImpactLight(hit.point, 3, 0x9ad0ff, 0.1);
      // Visible absorb: the attacker's arm bounces off the guard; the
      // defender's guard compresses under the impact.
      attacker.animator.applyReaction('shoulderR', 4, 0, -3);
      attacker.animator.applyReaction('elbowR', -6, 0, 0);
      defender.animator.applyReaction('elbowL', -3.5, 0, 0);
      defender.animator.applyReaction('elbowR', -3.5, 0, 0);
      defender.animator.applyReaction('torso', -1.5, 0, 0);
      this._hitFeedback(attack, false);
      this.audio.block(hit.point);
      return;
    }

    // Damage rolls: ±2 variance, scaled by charge, mass ratio, attack power,
    // region and the defender's existing region damage modifiers.
    let baseDmg = (attack.dmg * chargeMul + this.rng.randint(-1, 1))
      * effect.atkMul * regionMod * powerScale;

    // ── Per-hit personality modifiers ─────────────────────────────────
    // 1) The attacker may be carrying a temporary atkMul (Reagan's "Morning
    //    in America" / Bush's "Decider Mode"). Multiply baseDmg by it.
    // 2) The attacker may be in a retaliate window (Ford after being hit
    //    during his stumble). Multiply baseDmg by retaliateMul.
    // 3) The attacker may have a koStacks ramp (Trump: +5% per KO).
    // 4) Once-per-round Trump haymaker (1.5×), Trump flag set on
    //    swing commit in the AI tick already, so we read it here.
    //
    // Compute the combined personality damage mul: aggregates ALL president
    // modifiers into a single scalar that gets folded into baseDmg. Includes:
    //   - active modes (decider/morningInAmerica/dayOfInfamy/fourTerm)
    //   - Ford retaliate window + KO-stack ramp (Trump)
    //   - haymaker tag (Trump)
    //   - miss-charge (LBJ "The Treatment") — knockback only
    //   - LBJ pump swing counter
    //   - JFK Camelot Glint + Profiles in Courage
    //   - Eisenhower next-swing bonus
    //   - Truman Buck Stops Here stacks
    //   - FDR startup boost (subsumed via _applyOnHitPersonalities)
    const attPer = attacker.personality;

    // Quick dmg mul: reset on the swing commit so we accumulate fresh.
    attacker._personalityDmgMul = 1.0;
    // ── SUPER METER damage hook ──────────────────────────────────
    // Each super that boosts the NEXT swing (obama drone strike, clinton sax
    // solo, jfk profile manual, eisenhower overlord, eisenhower atoms-for-
    // peace, nixon pre-bonus, truman buck stops here) folds into the same
    // base multiplier the personality layer already manages. Multiplicative
    // stacking — a super during decider stacks with the decider atkMul.
    if (attPer && attPer.superSwingAtkMul && attPer.superSwingAtkMul > 1.0) {
      attacker._personalityDmgMul *= attPer.superSwingAtkMul;
      // Per-super one-shot supers consume their bonus here. Multi-swing
      // supers (nixon, bushsr) clear via their own counter in _enterAttack.
      const oneShot = ['droneStrike', 'saxSolo', 'profilesInCourage', 'overlord'];
      // Cheap ID-by-effect heuristic: if the personality id matches a super
      // that uses superSwingAtkMul as a one-shot, consume. Eisenhower's
      // passive Atoms-for-Peace path uses its own slot, not superSwingAtkMul.
      if (attPer && oneShot.includes(attPer.superActiveMode)) attPer.superSwingAtkMul = 1.0;
    }
    if (attPer?.activeMode && this.t < attPer.modeExpiresAt) {
      const trg = PERSONALITIES[attPer.id]?.onTriggerParams;
      if (attPer.activeMode === 'decider' && trg?.atkMul) attacker._personalityDmgMul *= trg.atkMul;
      if (attPer.activeMode === 'morningInAmerica' && trg?.atkMul) attacker._personalityDmgMul *= trg.atkMul;
    }
    if (attPer && this.t < attPer.retaliateUntil && PERSONALITIES.ford?.onStumbleHit) {
      attacker._personalityDmgMul *= PERSONALITIES.ford.onStumbleHit.retaliateDmgMul;
    }
    if (attPer && PERSONALITIES.trump?.perStackDmg && attPer.koStacks > 0) {
      attacker._personalityDmgMul *= 1 + attPer.koStacks * PERSONALITIES.trump.perStackDmg;
    }
    if (attacker._trumpHaymaker) {
      const cfg = PERSONALITIES.trump?.onSwingP;
      if (cfg) {
        attacker._personalityDmgMul *= cfg.haymakerDmgMul;
        attacker._trumpHaymaker = false;
      }
    }
    // Eisenhower next-swing bonus (cleared at hit landing).
    if (attPer?.id === 'eisenhower' && attPer.eisenhowerNextSwingAtkMul > 1.0) {
      attacker._personalityDmgMul *= attPer.eisenhowerNextSwingAtkMul;
      attPer.eisenhowerNextSwingAtkMul = 1.0;
    }
    // JFK "Profiles in Courage" next-swing bonus.
    if (attPer?.id === 'jfk' && attPer.jfkNextSwingAtkMul > 1.0) {
      attacker._personalityDmgMul *= attPer.jfkNextSwingAtkMul;
      attPer.jfkNextSwingAtkMul = 1.0;
    }

    // The "_applyOnHitPersonalities" helper accumulates the remaining new-
    // president muls (LBJ pump, JFK Glint, Truman stacks, FDR day/speed)
    // and is called BELOW right before the damage roll. We forward-declare
    // here for inline pre-computation:
    let personalityDmgMul = attacker._personalityDmgMul;
    baseDmg *= personalityDmgMul;

    // Iframes window from Carter "Malaise Speech" — drop the hit if the
    // defender has active iframes. Achieved by skipping damage entirely.
    // Also covers JFK Profiles-in-Courage iframes, Eisenhower Atoms-for-Peace,
    // and FDR Fireside Chat.
    const defPer = defender.personality;
    if (defPer && (
      (defPer.iframesUntil && this.t < defPer.iframesUntil)
      || (defPer.jfkProfileIframesUntil && this.t < defPer.jfkProfileIframesUntil)
      || (defPer.eisenhowerIframesUntil && this.t < defPer.eisenhowerIframesUntil)
      || (defPer.fdrIframesUntil && this.t < defPer.fdrIframesUntil))) {
      // Spark + audio but no damage, no hitstun, no knockback: it's a graze.
      this._spawnSparks(hit.point, 0xfff5b0, 4, 0.7);
      this._flashImpactLight(hit.point, 4, 0xfff5b0, 0.05);
      this.audio.block(hit.point);
      attacker.hasHit = true;        // still marks "did something"
      attacker._trumpHaymaker = false; // clean up
      return;
    }

    // Compute the on-hit personality mul BEFORE the damage roll (so the
    // rolled damage reflects LBJ pump / JFK Glint / Truman stacks / FDR day,
    // and side-effect counter increments like Truman's defense stacks fire
    // synchronously). The helper returns the residual personality dmg mul.
    const extraMul = this._applyOnHitPersonalities(attacker, defender, region, baseDmg, hit, attack);
    baseDmg *= extraMul;

    // Super meter fill on damage taken. Pure damage ratio: a hit that costs
    // 20% of HP fills ~ 1/5 of the meter — capped so a single massive hit
    // can't overflow. Reading baseDmg / MAX_HP keeps the meter stable across
    // character mass differences without per-president tuning.
    if (defender?.personality) {
      const fill = Math.min(0.5, baseDmg / MAX_HP);
      defender.personality.superMeter = Math.min(1.0,
        (defender.personality.superMeter || 0) + fill);
    }

    this.combat.damage({ playerId: defender.playerId, amount: baseDmg, sourceId: attacker.playerId });
    // A hit interrupts a wind-up (state → hitstun below) but no longer drains
    // the energy bar — per the rule that only winding up or attacking moves it.
    defender.state = 'hitstun';
    defender.stateT = 0;
    defender.chargeName = null;
    defender.chargeAmt = 0;
    defender.animator.setCharge(null, 0);
    defender.animator.setBlocking(false);
    defender.animator.play('hitstun');
    // ── LBJ "The Johnson Treatment" — KB mul if armed ────────────────
    // If LBJ swung within the miss-charge window, multiply knockback 1.5×
    // and consume the window.
    const lbjKBMul = (attPer?.lbjMissKBUntil && this.t < attPer.lbjMissKBUntil)
      ? (PERSONALITIES.lbj?.onOpponentMissCharge?.kbMul || 1.5)
      : 1.0;
    defender.knockback.add(knockDir.clone().multiplyScalar(4.5 * chargeMul * (atkMass / defMass) * lbjKBMul));
    if (lbjKBMul > 1) attPer.lbjMissKBUntil = 0;
    defender.animator.applyLean(knockDir.z * 0.15, -knockDir.x * 0.15);
    // Impact frame: cartoon squash on the defender (no color flash — per user
    // request the model's materials never change on hits).
    defender.squashT = 0.14;

    // Impulse-correct reactions: the struck region whips in the ACTUAL
    // direction of the blow (cannon contact normal), scaled by relative
    // strike speed and the mass ratio — a glancing jab and a stepped-in
    // cross now read differently with no per-case tuning.
    const rSide = hit.capsule.endsWith('L') ? 'L' : hit.capsule.endsWith('R') ? 'R' : null;
    const strikeSpeed = contact && contact.strikerVel
      ? Math.min(2, Math.hypot(contact.strikerVel.x, contact.strikerVel.z) / 6)
      : 1;
    const rPow = Math.min(2.2, (baseDmg / 8.75) * (0.6 + 0.4 * strikeSpeed));
    this._applyImpulseReactions(defender, region, rSide, impulseDir, rPow);

    // Rotational knockback: torque about the vertical axis from the contact
    // point's lever arm off the center of mass — hooks to the head spin the
    // defender off-facing, straight body shots push without spin.
    _leverArm.set(hit.point.x - dpos.x, 0, hit.point.z - dpos.z);
    const torqueY = _leverArm.x * impulseDir.z - _leverArm.z * impulseDir.x;
    defender.spinVel += THREE.MathUtils.clamp(
      torqueY * 5 * chargeMul * (atkMass / defMass), -4, 4);


    // Per-region damage at the actual contact point (drives the HUD body
    // diagram and the sweat/swell wear — never the model's colors). Charged
    // "power" hits front-load limb damage far more than they drain HP, so a
    // full-charge flurry to one section reddens it on the body diagram and can
    // tear the limb off before the KO (chargeMul 1 → CHARGE_MAX_MUL).
    const limbChargeMul = 1 + REGION_CHARGE_BONUS * (chargeMul - 1);
    defender.regionDmg[region] = Math.min(100,
      defender.regionDmg[region] + Math.max(2, baseDmg) * limbChargeMul);
    // Blows that land elsewhere still rattle the defender's guarding arms: a
    // small bleed on every hit plus a heavy charge-scaled bleed on power hits,
    // so the arms redden and eventually tear off over a fight even though clean
    // arm hits are geometrically rare and the KO would otherwise land first.
    if (region !== REGIONS.ARMS) {
      const bleed = Math.max(2, baseDmg) * (0.3 + ARM_SPLASH_FRAC * (chargeMul - 1));
      defender.regionDmg.arms = Math.min(100, defender.regionDmg.arms + bleed);
    }
    this._applyDamageWear(defender);

    // Dismemberment: once the arms region reddens, an arm tears off. Left first
    // (keeps the striking arm), right only at near-max once the left is gone.
    if (region === REGIONS.ARMS) {
      const armDmg = defender.regionDmg.arms;
      if (armDmg >= ARM_SEVER_R && defender.armsLost.has('L') && !defender.armsLost.has('R')) {
        this._severArm(defender, 'R', impulseDir);
      } else if (armDmg >= ARM_SEVER_L && !defender.armsLost.has('L')) {
        this._severArm(defender, 'L', impulseDir);
      }
    }

    // Facial reaction: a grimace held briefly, then back to the resting face.
    setExpression(defender.rig, 'hurt');
    defender.expressionT = 0.7;

    // ── On-hit personality effects ─────────────────────────────────────
    this._applyOnHitPersonalities(attacker, defender, region, baseDmg, hit, attack);

    if (defender.controller.notifyHit) defender.controller.notifyHit();
    // Sparks + a real light flash at the contact point, not at the defender's root.
    this._spawnSparks(hit.point, region === REGIONS.HEAD ? 0xff5530 : 0xffc857,
      Math.round(8 * chargeMul), 1.4 * chargeMul);
    // Roughly 1-in-4 face hits draw blood; charged shots more often.
    if (region === REGIONS.HEAD && this.rng.random() < 0.22 + 0.3 * (chargeMul - 1)) {
      this._spawnBlood(hit.point, impulseDir, chargeMul);
    }
    // Per-region hit-light color: head=hot red, arms=orange, torso=warm
    // white, legs=cool yellow. Lets the player read WHERE they got hit
    // by the kick-out color, not just the spark tone.
    const regionHitColors = {
      [REGIONS.HEAD]: 0xff3030,
      [REGIONS.ARMS]: 0xffb050,
      [REGIONS.TORSO]: 0xffe1a0,
      [REGIONS.LEGS]: 0xfff060,
    };
    const hitColor = regionHitColors[region] || 0xffa050;
    const flashDur = region === REGIONS.HEAD ? 0.25 : 0.18;
    this._flashImpactLight(hit.point,
      (attack.name === 'kick' ? 12 : 8) * chargeMul,
      hitColor, flashDur);
    this._hitFeedback(attack, true, chargeMul);
    // Directional camera kick: the boom takes the hit's impulse and the
    // spring settles it — the camera is knocked the way the fighter is.
    this._camVel.addScaledVector(impulseDir,
      (attack.name === 'kick' ? 1.5 : 0.9) * chargeMul);
    this._camVel.y += 0.35 * chargeMul;
    this.audio.impact({ power: Math.min(2, baseDmg / 3), worldPos: hit.point, kind: attack.name });
    this.audio.grunt({ power: Math.min(2, baseDmg / 3) });
    this.hudDirty = true;

    // Resolve death/winner.
    for (const ev of this.combat.step()) {
      if (ev.type === COMBAT_EVENTS.PLAYER_KILLED) {
        const downed = this.fighters.find((x) => x.playerId === ev.playerId);
        if (downed) {
          downed.state = 'ko';
          downed.animator.frozen = true;
          downed.animator.play(null);
          // Trump personality: KO-stack increment on the WINNER. Each stack
          // adds +5% damage on every swing for the rest of the match.
          const winner = this.fighters.find((x) => x !== downed);
          if (winner?.personality?.id === 'trump'
              && PERSONALITIES.trump?.onKoReceived === 'stack'
              && winner.personality.koStacks
                  < (PERSONALITIES.trump.maxStacks || 5)) {
            winner.personality.koStacks += 1;
          }
          // Queue the rigid-body ragdoll. Built next tick in _buildPendingKO
          // — this handler can run inside cannon's contact dispatch, where
          // adding/removing bodies is unsafe. Momentum carries into the
          // launch so a KO mid-dash tumbles with the motion.
          downed.pendingKO = {
            knockDir: knockDir.clone(),
            velocity: downed.vel.clone().add(downed.knockback),
            // Shape of the killing blow — _buildPendingKO turns this into
            // launch loft / flip / spin on the rigid-body ragdoll.
            region,
            attackName: attack.name,
            hitY: hit.point.y,
            spin: torqueY,
          };
        }
      } else if (ev.type === COMBAT_EVENTS.COMBAT_FINISHED) {
        this.phase = 'ko';
        this.phaseT = 0;
        this.timeScale = 0.35;
        this.cameraMode = 'ko';
        this.cameraModeT = 0;
        // Shot selection: ~40% of KOs get the overhead face close-up (the
        // dazed expression as the body drops); the rest keep the low side
        // push-in. Seeded RNG keeps demo replays reproducible.
        this.koShot = this.rng.random() < 0.4 ? 'overhead' : 'side';
        this.winner = ev.winnerTeamId ? Number(ev.winnerTeamId) : 0;
        // Winner flashes the grin; the KO'd fighter keeps the dazed face
        // (expressionT stays 0 so nothing resets either one).
        const wf = this.winner ? this.fighters[this.winner - 1] : null;
        if (wf) { setExpression(wf.rig, 'grin'); wf.expressionT = 0; }
        // Sometimes the victor celebrates — decided here (seeded RNG keeps
        // demo replays reproducible) but the hopping starts at the 'result'
        // transition so the slow-mo KO fall keeps its drama.
        this.pendingCelebration = (wf && this.rng.random() < 0.55) ? wf : null;
        this._setBanner('K.O.!');
        this.audio.ko();
        this._triggerFlash();
        // Keep the KO frame crisp: cancel the radial-blur streak, chromatic
        // aberration and bloom spike the killing blow's _hitFeedback would
        // otherwise leave smeared across the screen. Per-hit feedback during
        // the fight is untouched; the exposure spike + lights-down color
        // drain (uDesat) stay — those aren't blur.
        this.radialPulse = 0;
        this.caPulse = 0;
        this.bloomPulse = 0;
        this.exposurePulse = 0.35;
        // §GFX-2 — rack onto the fallen fighter. Focus distance is measured to
        // the actual body rather than assumed, because the KO camera has two
        // shots (low side push-in and overhead) at very different ranges, and a
        // fixed distance would put the subject out of focus on one of them.
        if (this.rackFocus) {
          this.rackFocus.trigger(this.camera.position.distanceTo(dpos), 1.4, 1.2);
        }
        // The shared feel layer: this is the heaviest event the app produces.
        window.PoImpact?.impact('heavy', 1.6);
        // Big warm flash over the fallen fighter as the house lights dim.
        this._flashImpactLight(
          new THREE.Vector3(dpos.x, dpos.y + 1.0, dpos.z), 22, 0xfff0d0, 0.4);
        this.excited = 1;
        this._spawnConfetti();

        // The KO limelight went with the lights-down cinematic (2026-08-07).
        // A 6.0-intensity white spot only reads as "dramatic" against a dark
        // hall; with the house lights now staying up it was just a blown-out
        // hotspot on the fallen fighter. Left disarmed rather than deleted so
        // the rig is still there if the cinematic is ever wanted back.
        this._limelightActive = 0;
      }
    }

    // ── Heavy-hit stagger ─────────────────────────────────────────────
    // Fighters stay on their feet until the killing blow: a heavy hit
    // (most kicks, clean head punches) that doesn't kill gets an amplified
    // stagger — extra knockback and a deep lean — but never a knockdown.
    if (defender.state !== 'ko' && baseDmg >= HEAVY_HIT_DMG) {
      defender.knockback.add(knockDir.clone().multiplyScalar(3.0 * (atkMass / defMass)));
      defender.animator.applyLean(knockDir.z * 0.2, -knockDir.x * 0.2);
      // A near-drop dishevels the hair for the rest of the match.
      if (defender.rig.refs) defender.rig.refs.hairPivot.rotation.y = 0.3;
      this.excited = Math.max(this.excited, 0.6);
      // Sweat spray whips off the rocked head.
      defender.rig.joints.head.getWorldPosition(_sweatPos);
      this._spawnSweat(_sweatPos);
      // Stagger ragdoll (#4): the heaviest non-lethal hits throw a brief
      // whole-body flail — arms fling, elbows whip, torso pitches, the head
      // snaps — driven through the reaction-spring system so it recovers on
      // its own. Reads as a momentary loss of control without a knockdown.
      if (baseDmg >= HEAVY_HIT_DMG * 1.35) {
        this._staggerFlail(defender, knockDir);
      }
    }
  }

  // A short, recoverable "partial ragdoll": a burst of reaction-spring impulses
  // across the upper body so a rocked fighter flails before the springs settle
  // them back to guard. Cheaper and far safer than swapping the live rig to a
  // physics ragdoll mid-fight, and it reads as the same beat.
  _staggerFlail(f, knockDir) {
    const a = f.animator;
    if (!a) return;
    const s = knockDir.x >= 0 ? 1 : -1;
    const back = -knockDir.z; // pitch magnitude away from the blow
    a.applyReaction('shoulderR', 7 * back, 0, -7 * s);
    a.applyReaction('shoulderL', 7 * back, 0, 7 * s);
    a.applyReaction('elbowR', -10, 0, 0);
    a.applyReaction('elbowL', -10, 0, 0);
    a.applyReaction('torso', -5, 0, -2.5 * s);
    a.applyLean(knockDir.z * 0.34, -knockDir.x * 0.34);
    f.spinVel += 2.2 * s;        // a little uncontrolled yaw whip
    setExpression(f.rig, 'hurt');
    f.expressionT = Math.max(f.expressionT, 0.55);
  }

  // Accumulating damage wear — SHAPE AND SHINE ONLY. Per user request the
  // model's colors never change when a fighter is hit or knocked out: no
  // bruise tints, no emissive hit-flash, no cut decal. Damage is read from
  // the HUD body diagram instead. What remains here is sweat glisten
  // (roughness drops — the fighter gets shinier as the fight wears on) and
  // cheek/brow swelling, both frozen once the fighter is down/KO'd so the
  // fallen silhouette stays consistent under the result modal.
  _applyDamageWear(f) {
    if (f.state === 'ko') return;
    const total = (f.regionDmg.head + f.regionDmg.torso
      + f.regionDmg.arms + f.regionDmg.legs) / 400;
    const sweat = Math.min(1, total * 1.6);
    const skin = f.rig.materials.skinMat;
    skin.roughness = 0.55 - 0.3 * sweat;
    f.rig.materials.suitMat.roughness = 0.95 - 0.3 * sweat;
    // Wet-sheen ramp (idea #6): a rising clearcoat lobe + a hotter skin sheen
    // is what actually reads as SWEAT — a lowered roughness alone just makes
    // the skin a flatter matte. The clearcoat gives the glistening second
    // specular highlight of a sweat film; sheen widens the grazing-angle
    // glow. Both ride the same sweat value the roughness drop uses.
    skin.clearcoat = 0.55 * sweat;
    skin.sheen = 0.32 + 0.25 * sweat;
    // The face has its own materials now (tinted skin + painted detail
    // plate) — they glisten with the rest of the skin.
    if (f.rig.materials.faceMat) {
      const fm = f.rig.materials.faceMat;
      fm.roughness = 0.55 - 0.3 * sweat;
      fm.clearcoat = 0.55 * sweat;
      fm.sheen = 0.32 + 0.25 * sweat;
    }
    if (f.rig.materials.plateMat) f.rig.materials.plateMat.roughness = 0.6 - 0.3 * sweat;
    if (f.rig.refs) {
      const hd = Math.min(1, f.regionDmg.head / 100);
      f.rig.refs.skull.scale.set(1 + hd * 0.07, 1, 1 + hd * 0.05);
    }
  }

  _hitFeedback(attack, connected, chargeMul = 1) {
    if (!connected) {
      this.shakeT = 0.08; this.shakeAmp = 0.05;
      return;
    }
    // Hit-pause scales with attack weight and stored charge — a fully charged
    // release lands with roughly double the stop, shake and lens kick.
    const frames = Math.round((attack.name === 'kick' ? 5 : 3) * chargeMul);
    this.hitstopT = frames * SIM_DT;
    // Random jitter is halved — the directional spring impulse (injected at
    // the _tryHit call site) now carries most of the camera reaction.
    this.shakeT = 0.14;
    this.shakeAmp = (attack.name === 'kick' ? 0.09 : 0.06) * chargeMul;
    this.fovPunch = (attack.name === 'kick' ? 5.0 : 3.0) * chargeMul;
    // Post-FX spikes on impact: REMOVED 2026-08-07 (user request).
    //
    // A hit used to flare the bloom, blow the exposure open and fire a radial
    // streak that darkened the frame edges. Each one is a full-frame luminance
    // change lasting a few hundred ms, and in a normal exchange — several hits a
    // second, each re-arming the pulse via Math.max before the previous had
    // decayed — they overlapped into a continuous flicker across the whole
    // image. The chromatic-aberration pulse went earlier for the same reason,
    // and bloom/radial had already been halved twice without fixing it, so they
    // are off rather than dialled down again.
    //
    // The hit still lands hard: hitstop, camera shake, the FOV punch, the
    // directional spring impulse, the impact spark light, audio and haptics are
    // all untouched above. What is gone is only the part that strobed the
    // picture. _updateFx still decays these fields, so nothing else needs to
    // know they are now always zero.
  }

  // Decay the post-FX pulses and push them into the passes.
  _updateFx(dt) {
    this.caPulse *= Math.exp(-dt * 4);
    this.bloomPulse *= Math.exp(-dt * 5);
    this.exposurePulse *= Math.exp(-dt * 5);
    this.radialPulse *= Math.exp(-dt * 7);
    // §GFX-2 — no-op unless a KO is running.
    if (this.rackFocus) this.rackFocus.update(dt);
    if (this.fxPass) {
      // The shared impact envelope is ADDED to this game's own pulses rather
      // than replacing them. PoBrawl's per-attack feedback is tuned to the
      // attack (a kick smears more than a jab) and that nuance is worth
      // keeping; impactBus contributes the part that is common to every game,
      // so a hit now punches the 3D image and shakes the DOM chrome on one
      // shared curve instead of two that drift apart.
      this.fxPass.uniforms.uCA.value = this.caPulse + PostFx.punchAberration(0.8);
      this.fxPass.uniforms.uRadial.value = this.radialPulse + PostFx.punchRadial(0.35);
      // KO color drain rides the lights-down blend (keeps the reds hot).
      this.fxPass.uniforms.uDesat.value = this.lightsDim * 0.55;

      // Film grain clock (idea #10). atmoT always advances, even between
      // rounds, so the grain never freezes on a paused frame.
      this.fxPass.uniforms.uTime.value = this.atmoT;
      // Vignette breathing (idea #10): a slow ±0.04 swell around the 0.5 base,
      // tightening hard as the house lights drop for the KO so the frame
      // closes in on the fallen fighter.
      this.fxPass.uniforms.uVignette.value =
        0.5 + 0.04 * Math.sin(this.atmoT * 0.7) + this.lightsDim * 0.35;

      // ── Godrays (idea #10) — REMOVED 2026-08-07 (user request) ───────
      // This was a 16-tap radial smear from every pixel toward the overhead
      // spotlight's projected screen position, so it drew visible streaks
      // fanning out from wherever that light happened to land — usually the
      // upper-left of the frame. It ran at a constant 0.07 baseline during
      // normal play ("keeps the overhead shaft reading as volumetric") on top
      // of the KO ramp, so it never actually switched off; killing the KO
      // lights-down left the streaks behind.
      //
      // Held at 0 so the shader's `if (uGodrays > 0.003)` branch is skipped
      // outright — that also drops 16 texture samples per pixel per frame.
      // The projection maths that fed uGodraysOrig went with it; nothing else
      // reads that uniform.
      this.fxPass.uniforms.uGodrays.value = 0;
    }
    if (this.bloomPass) this.bloomPass.strength = 0.32 + this.bloomPulse;
    this.renderer.toneMappingExposure = this.exposureBase + this.exposurePulse;

    // Impact-light pool decay.
    for (const s of this._impactLights || []) {
      if (s.life > 0) {
        s.life = Math.max(0, s.life - dt);
        s.light.intensity = s.peak * (s.life / s.dur);
      }
    }
  }

  // Flash one pooled PointLight at a world position (hit sparks, KO).
  _flashImpactLight(point, peak, color = 0xffa050, dur = 0.15) {
    if (!this._impactLights) return;
    const slot = this._impactLights[this._impactCursor++ % this._impactLights.length];
    slot.light.color.setHex(color);
    slot.light.position.set(point.x, point.y + 0.2, point.z);
    slot.peak = peak;
    slot.dur = dur;
    slot.life = dur;
    slot.light.intensity = peak;
  }

  // House-light choreography. Backlights track their fighters every frame for
  // rim separation.
  //
  // 2026-08-07 (user request): the KO "lights-down" cinematic is removed. It
  // used to ramp `lightsDim` to 1 on a KO, which cut hemi/key/fill by 75-85%,
  // pulled the vignette from 0.50 to 0.85, drained 55% of the colour and blew
  // the godrays out to a full shaft. On anything but a bright display the
  // result was a screen that simply went black for a second and came back
  // washed-out and grainy. Pinned to 0 so every consumer of `lightsDim`
  // (uDesat, uVignette, uGodrays and the four house lights below) collapses to
  // its neutral, lights-up value. The KO still reads through the flash, the
  // slow-mo fall, the replay and the banner.
  _updateLighting(dt) {
    const L = this.arena && this.arena.lights;
    if (!L) return;
    this.lightsDim = 0;
    const d = this.lightsDim;
    L.hemi.intensity = 0.22 * (1 - d * 0.85);
    L.key.intensity = 3.4 * (1 - d * 0.75);
    L.rim.intensity = 1.0 * (1 - d * 0.5);
    L.fill.intensity = 0.6 * (1 - d * 0.85);

    // ── Personality-driven rim pulses ─────────────────────────────
    // Active modes (Reagan morningInAmerica, Bush decider, FDR fourTerm, etc.)
    // tint the rim light. The key/fill stay neutral; only the rim breathes.
    // Multiple personalities can pulse — pick the strongest tint and lerp
    // toward the warm/cool midpoint so the rim never goes wild.
    let rimTint = new THREE.Color(0x6070ff);   // default cool blue rim
    let rimMul = 1.0;
    if (this.fighters) {
      for (const f of this.fighters) {
        const per = f.personality;
        if (!per) continue;
        const mode = per.activeMode;
        const t = per.modeExpiresAt ? Math.max(0, per.modeExpiresAt - this.t) : 0;
        if (mode === 'morningInAmerica' && PERSONALITIES.reagan) {
          // Pulse gold every ~0.5 s.
          const pulse = 0.5 + 0.5 * Math.sin(this.t * 6.0);
          rimTint = new THREE.Color(0xffd66b).lerp(rimTint, 1 - pulse);
          rimMul = Math.max(rimMul, 1.0 + 0.35 * pulse);
        } else if (mode === 'decider' && PERSONALITIES.bush) {
          // Magenta steady-burn — Bush's "decision moment".
          rimTint = rimTint.clone().lerp(new THREE.Color(0xff59a8), 0.65);
          rimMul = Math.max(rimMul, 1.05);
        } else if (mode === 'fourTerm' && PERSONALITIES.fdr) {
          // Warm amber for FDR's warm-up; settles back to blue at expiry.
          rimTint = rimTint.clone().lerp(new THREE.Color(0xffb056), 0.6);
        } else if (mode === 'malaiseSpeech' && PERSONALITIES.carter) {
          // Cool teal — Carter's "wake up" call.
          rimTint = rimTint.clone().lerp(new THREE.Color(0x6cd6c4), 0.5);
        } else if (mode === 'dayOfInfamy' && PERSONALITIES.fdr) {
          // Crimson — FDR rises at 30% HP. Strong + sustained, not pulsing.
          rimTint = rimTint.clone().lerp(new THREE.Color(0xff3232), 0.7);
          rimMul = Math.max(rimMul, 1.15);
        }
        // Per-fighter single-fire person pulses that aren't activeModes.
        if (f.charId === 'jfk' && per.jfkProfileIframesUntil && this.t < per.jfkProfileIframesUntil) {
          rimTint = rimTint.clone().lerp(new THREE.Color(0xfff7c2), 0.55);
        }
        if (f.charId === 'eisenhower' && per.eisenhowerIframesUntil && this.t < per.eisenhowerIframesUntil) {
          rimTint = rimTint.clone().lerp(new THREE.Color(0x9edcff), 0.55);
        }
        if (f.charId === 'fdr' && per.fdrIframesUntil && this.t < per.fdrIframesUntil) {
          rimTint = rimTint.clone().lerp(new THREE.Color(0xfff0c0), 0.5);
        }
      }
    }
    L.rim.color.copy(rimTint);
    L.rim.intensity *= rimMul;
    L.cornerA.intensity = 1.7 * (1 - d * 0.9);
    L.cornerB.intensity = 1.7 * (1 - d * 0.9);
    L.spot.intensity = 1.6 + d * 1.6;
    // Studio rig panels dim with the house lights.
    if (L.rectA) L.rectA.intensity = 3.4 * (1 - d * 0.85);
    if (L.rectB) L.rectB.intensity = 2.6 * (1 - d * 0.85);
    // The volumetric shaft brightens as the hall goes dark — the classic
    // "single spotlight through smoky air" KO moment.
    const atmo = this.arena.atmo;
    if (atmo && atmo.cone) {
      atmo.cone.material.opacity = 0.09 + d * 0.14;
    }

    // ── Room light swing ──────────────────────────────────────────────
    // The overhead house light isn't nailed above the ring centre: it traces
    // a wide elongated ellipse up in the rig (mostly along Z, with a smaller
    // X amplitude and a strong vertical bob), aimed down at the two fighters,
    // so the pool of light, the cast shadows and the volumetric shaft all
    // sweep visibly back and forth across the canvas over the course of a
    // round instead of sitting dead still. One full cycle takes ~12 s — fast
    // enough to read as a swinging rig fixture, slow enough that it doesn't
    // feel like a strobe.
    this._houseT = (this._houseT || 0) + dt;
    const orbit = this._houseT * HOUSE_LIGHT_SPEED;
    L.spot.position.set(
      Math.cos(orbit) * HOUSE_LIGHT_RADIUS_X,
      HOUSE_LIGHT_HEIGHT + Math.sin(orbit * 1.4) * HOUSE_LIGHT_BOB,
      Math.sin(orbit) * HOUSE_LIGHT_RADIUS);

    // Spotlight target: the midpoint between the fighters normally, the loser
    // during the KO.
    const loser = this.fighters && this.fighters.find((f) => f.state === 'ko');
    if (loser && d > 0.01) {
      const lp = loser.rig.root.position;
      _spotTarget.set(lp.x, 0, lp.z);
    } else if (this.fighters && this.fighters.length === 2) {
      const a = this.fighters[0].rig.root.position;
      const b = this.fighters[1].rig.root.position;
      _spotTarget.set((a.x + b.x) * 0.5, 0, (a.z + b.z) * 0.5);
    } else {
      _spotTarget.set(0, 0, 0);
    }
    L.spot.target.position.lerp(_spotTarget, Math.min(1, dt * 3));
    L.spot.target.updateMatrixWorld();

    // Keep the fake volumetric shaft glued to the beam: the cylinder's +Y
    // points back up at the lamp, and its centre sits 5.4 units down the beam
    // — the same offset it had baked in when the lamp hung fixed at y = 11.
    if (atmo && atmo.cone) {
      _beamDir.copy(L.spot.position).sub(L.spot.target.position);
      if (_beamDir.lengthSq() < 1e-6) _beamDir.set(0, 1, 0); else _beamDir.normalize();
      atmo.cone.quaternion.setFromUnitVectors(_upY, _beamDir);
      atmo.cone.position.copy(L.spot.position).addScaledVector(_beamDir, -5.4);
    }

    // (The godray blade's screen-space origin was fed from L.spot.position
    // here. Godrays were removed 2026-08-07 — see the uGodrays note in
    // _updateFx — so nothing consumes it any more.)

    // Backlights: behind each fighter, opposite the camera.
    if (this.fighters && this._backlights) {
      for (let i = 0; i < this.fighters.length; i++) {
        const fp = this.fighters[i].rig.root.position;
        const bl = this._backlights[i];
        if (!bl) continue;
        _blDir.copy(fp).sub(this.camera.position);
        _blDir.y = 0;
        if (_blDir.lengthSq() < 1e-6) _blDir.set(0, 0, -1);
        _blDir.normalize();
        bl.position.set(fp.x + _blDir.x * 3, 3.2, fp.z + _blDir.z * 3);
        bl.target.position.set(fp.x, 1.0, fp.z);
        bl.intensity = 3.0 * (1 - d * 0.5);
      }
    }

    // ── KO Limelight ─────────────────────────────────────────────────
    // Sits above and sweeps horizontally across the loser during the KO
    // cinematic. Decreases each frame; intensity rises as house lights dim
    // so the contrast between dark hall and tight white slash is dramatic.
    if (this._limelightActive > 0 && this._limelight) {
      this._limelightActive -= dt;
      const lf = this.fighters.find((f) => f.state === 'ko');
      if (lf) {
        // Lerp the target over the body — tracks the falling hips smoothly.
        const ft = lf.rig.joints.torso.getWorldPosition(_blDir);
        _blDir.copy(ft);
        this._limelightTarget.lerp(_blDir, Math.min(1, dt * 4));
        this._limelight.target.position.copy(this._limelightTarget);
      }
      // Spotlight lives off-screen-ish, brushes the loser from above-right.
      const tx = this._limelightTarget.x;
      const tz = this._limelightTarget.z;
      this._limelight.position.set(tx + 2.5, 6.5, tz - 1.2);
      // Fades 0→6 over the first 0.4 s, holds, fades on expiring.
      const t = THREE.MathUtils.clamp(
        Math.min(this._limelightActive, 3.5 - this._limelightActive + 0.5) / 0.6, 0, 1);
      this._limelight.intensity = Math.max(0, 6.0 * t);
      // Cool the colour as we ramp — warm at start, white at peak (looks
      // cinematic vs. the warm key).
      this._limelight.color.setHex(this._limelightActive > 3.0 ? 0xfff0d0 : 0xffffff);
    } else if (this._limelight && this._limelight.intensity !== 0) {
      this._limelight.intensity = 0;
    }

    // ── KO Victor Halo ─────────────────────────────────────────────
    // Contrasting cooler spotlight follows the WINNER (not the loser). The
    // tight white-on-loser + cool halo-on-winner reads as "the audience
    // sees both fighters in their final moments" — cinematic.
    if (this.phase === 'ko' && this.winner && this.fighters) {
      const wf = this.fighters[this.winner - 1];
      if (wf && this._victorHalo) {
        const wpos = wf.rig.root.position;
        this._victorHalo.position.set(wpos.x - 1.4, 3.4, wpos.z - 0.8);
        this._victorHalo.target.position.set(wpos.x, 1.0, wpos.z);
        // Halo rises with house-dim, then fades as the result screen takes
        // over (the result modal flips cameraMode to 'result' and we drop
        // the halo there).
        const cam = this.cameraMode;
        const haloT = THREE.MathUtils.clamp(cam === 'ko' ? d * 1.4 : 0, 0, 1);
        this._victorHalo.intensity = 2.6 * haloT;
        this._victorHalo.color.setHex(0xa0c4ff);
      }
    } else if (this._victorHalo) {
      this._victorHalo.intensity = 0;
    }
  }

  // Shared radial-gradient texture for the fighters' contact-shadow blobs.
  // Override `opts.inner` / `opts.outer` to tint variants (e.g. AO discs
  // want a harder black inner).
  _makeBlobTexture(opts = {}) {
    const inner = opts.inner || 'rgba(0,0,0,0.9)';
    const mid = opts.mid || 'rgba(0,0,0,0.45)';
    const outer = opts.outer || 'rgba(0,0,0,0)';
    const cacheKey = `${inner}|${mid}|${outer}`;
    if (this._blobTexCache && this._blobTexCache.key === cacheKey) return this._blobTexCache.tex;
    if (!this._blobTexCache) this._blobTexCache = {};
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.55, mid);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    this._blobTexCache = { key: cacheKey, tex };
    return tex;
  }

  // Per-tick posture: head tracking toward the opponent, momentum lean from
  // the fighter's own velocity/acceleration, and the clinch-frame blend at
  // chest-to-chest range. All feed overlay targets on the animator.
  _updatePosture(f, opp, dt) {
    if (!opp || f.state === 'ko') return;
    const anim = f.animator;

    // ── Head tracking: look at the opponent's upper body ─────────────
    f.rig.joints.head.getWorldPosition(_lookA);
    opp.rig.joints.hips.getWorldPosition(_lookB);
    _lookB.y += 0.55; // chest height
    const dx = _lookB.x - _lookA.x, dz = _lookB.z - _lookA.z;
    const horiz = Math.hypot(dx, dz);
    let yawLocal = Math.atan2(dx, dz) - f.rig.root.rotation.y;
    while (yawLocal > Math.PI) yawLocal -= Math.PI * 2;
    while (yawLocal < -Math.PI) yawLocal += Math.PI * 2;
    // Pitch: negative x rotation looks up; a downed opponent pulls the gaze down.
    const pitch = -Math.atan2(_lookB.y - _lookA.y, Math.max(horiz, 0.4));
    anim.setLook(yawLocal, pitch);

    // ── Momentum lean: into acceleration, counter-lean when braking ──
    const vx = f.vel.x + f.knockback.x, vz = f.vel.z + f.knockback.z;
    const ax = (vx - (f._pvx ?? vx)) / dt, az = (vz - (f._pvz ?? vz)) / dt;
    f._pvx = vx; f._pvz = vz;
    const yaw = f.rig.root.rotation.y;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const lvz = vx * sin + vz * cos, lvx = vx * cos - vz * sin;   // local fwd/side vel
    const laz = ax * sin + az * cos, lax = ax * cos - az * sin;   // local fwd/side accel
    anim.setMoveLean(lvz * 0.06 + laz * 0.006, -(lvx * 0.05 + lax * 0.005));

    // ── Clinch frame: arms brace when chest-to-chest, nobody swinging ─
    const dist = f.rig.root.position.distanceTo(opp.rig.root.position);
    const passive = (s) => s === 'idle' || s === 'block';
    anim.setClinch(dist < 1.05 && passive(f.state) && passive(opp.state));
  }

  // Track each fighter's hips; widen + darken the blob as the body drops
  // (knockdown/KO) so the lying pose still reads as grounded. The AO disc
  // is a separate, tighter patch that stays anchored under the planted
  // feet — sells "not floating".
  _updateBlobShadows() {
    if (!this.fighters) return;
    for (const f of this.fighters) {
      if (!f.blob) continue;
      f.rig.joints.hips.getWorldPosition(_blobPos);
      f.blob.position.x = _blobPos.x;
      f.blob.position.z = _blobPos.z;
      const standing = THREE.MathUtils.clamp((_blobPos.y - 0.15) / 0.85, 0, 1);
      const s = THREE.MathUtils.lerp(1.5, 1.0, standing);
      f.blob.scale.set(s, s, 1);
      f.blob.material.opacity = THREE.MathUtils.lerp(0.5, 0.34, standing);

      // AO disc: tracks the planted foot rather than the hips. While
      // standing the disc stays tight; as the body drops it slides out a
      // bit but never balloons like the contact blob.
      if (f.aoDisc) {
        f.rig.joints.footR.getWorldPosition(_blobPos);
        f.aoDisc.position.x = _blobPos.x;
        f.aoDisc.position.z = _blobPos.z;
        const aos = THREE.MathUtils.lerp(1.4, 1.0, standing);
        f.aoDisc.scale.set(aos, aos, 1);
        // AO fades when the body is upright (where the blob does the work)
        // and goes pitch-black when prone (where it sells the lie-down).
        f.aoDisc.material.opacity = THREE.MathUtils.lerp(0.8, 0.25, standing);
      }
    }
  }

  _triggerFlash() {
    // CSS chromatic-aberration flash on KO — DOM overlay so we don't need a
    // post-processing chain. Auto-clears on the next animation frame.
    if (!this.flash) return;
    this.flash.classList.remove('pb-flash-active');
    void this.flash.offsetWidth; // force reflow
    this.flash.classList.add('pb-flash-active');
  }

  // Hooks handed to props.js so the crate module can push damage / FX back
  // through the engine without importing it.
  _makePropHooks() {
    return {
      onChip: (f, dmg, dx, dz) => this._propChip(f, dmg, dx, dz),
      onImpactFx: (pos, power) => {
        this._spawnSparks(pos, 0xc8a060, 8, 1.6);
        this.audio.impact({ power: power ?? 1, worldPos: pos });
      },
    };
  }

  // Secondary "chip" damage from crashing into / getting hit by a crate
  // (chain reactions, corner turnbuckle). Capped so a crate can never land the
  // KILLING blow — HP is floored at 5 — keeping the KO strictly a fist/foot
  // event and the combat/KO pipeline untouched.
  _propChip(f, dmg, dx = 0, dz = 0) {
    if (!f || f.state === 'ko' || dmg <= 0) return;
    const player = this.combat.getPlayer(f.playerId);
    if (!player) return;
    const capped = Math.min(dmg, Math.max(0, player.health - 5));
    if (capped <= 0.1) return;
    this.combat.damage({ playerId: f.playerId, amount: capped, sourceId: f.playerId });
    this.hudDirty = true;
    const p = f.rig.root.position;
    this._spawnSparks(new THREE.Vector3(p.x, 1.0, p.z), 0xffd0a0, 5, 1.2);
    this.audio.grunt({ power: 0.6 });
    setExpression(f.rig, 'hurt');
    f.expressionT = Math.max(f.expressionT, 0.4);
  }

  // Remove a fighter's live-fight cannon bodies (rig root, hurt spheres,
  // constraints). Used at KO handoff (the ragdoll replaces them), respawn
  // and dispose. Never call from inside a physics step.
  _removeFighterPhysics(f) {
    if (!this._physics || !f.fighterPhysics) return;
    const world = this._physics.world;
    for (const s of f.fighterPhysics.hurtSpheres) {
      if (world.bodies.includes(s)) world.removeBody(s);
    }
    for (const c of f.fighterPhysics.constraints) {
      if (world.constraints.includes(c)) world.removeConstraint(c);
    }
    if (world.bodies.includes(f.fighterPhysics.rigRoot)) {
      world.removeBody(f.fighterPhysics.rigRoot);
    }
    f.fighterPhysics = null;
  }

  // Deferred KO-ragdoll construction. The KO event only queues pendingKO;
  // here — safely outside world.step — we swap the fighter's live-fight
  // bodies for the jointed rigid-body skeleton and launch it.
  _buildPendingKO() {
    for (const f of this.fighters) {
      if (!f.pendingKO || f.state !== 'ko') continue;
      this._destroySwingPhysics(f);
      this._removeFighterPhysics(f);
      // Shape the launch from the killing blow: high head punches loft the
      // body with a backward whip (uppercut), leg hits sweep it into a
      // forward flip, body kicks drive it flat and fast. The lateral spin
      // of the final hit's torque carries into the tumble.
      const ko = f.pendingKO;
      const knockDir = ko.knockDir.clone();
      let velocity = ko.velocity;
      let launch = { upMul: 1, flip: 1.2, spin: THREE.MathUtils.clamp((ko.spin || 0) * 0.8, -4, 4) };
      // Punch KOs: sometimes the victim doesn't fly at all. ~22% crumple
      // straight down where they stand (lights out, legs give way); ~23%
      // slump FORWARD onto the opponent — the reversed knock direction
      // drops the body against the winner's root collider, so it visibly
      // leans on him and slides down.
      const punchRoll = ko.attackName === 'punch' ? this.rng.random() : 1;
      if (punchRoll < 0.22) {
        launch = { upMul: 0.35, flip: 0.5, spin: launch.spin * 0.4, knockMul: 0.06, velMul: 0.1 };
        velocity = { x: 0, z: 0 };
      } else if (punchRoll < 0.45) {
        knockDir.negate(); // fall INTO the attacker
        launch = { upMul: 0.45, flip: -2.2, spin: launch.spin * 0.5, knockMul: 0.35, velMul: 0.1 };
        velocity = { x: 0, z: 0 };
      } else if (ko.region === REGIONS.HEAD && ko.attackName === 'punch' && (ko.hitY ?? 0) > 1.45) {
        launch = { ...launch, upMul: 1.9, flip: -5 };          // uppercut loft + backflip
      } else if (ko.region === REGIONS.LEGS) {
        launch = { ...launch, upMul: 1.35, flip: 6.5 };        // swept — forward flip
      } else if (ko.region === REGIONS.TORSO && ko.attackName === 'kick') {
        launch = { ...launch, upMul: 0.85, flip: 2.5 };        // driven flat and fast
      }
      f.koRagdoll.activate(knockDir, {
        velocity,
        rng: this.rng,
        launch,
      });
      f.pendingKO = null;
    }
  }

  _tickKoFall(dt) {
    for (const f of this.fighters) {
      if (f.state !== 'ko') continue;
      // Rigid-body KO: cannon owns the pose; mirror it onto the rig.
      if (f.koRagdoll && f.koRagdoll.active) {
        f.koRagdoll.drive();
        continue;
      }
      // Fallback (no ragdoll): rigid root tilt. Kept as a safety net.
      const root = f.rig.root;
      root.rotation.x = THREE.MathUtils.lerp(root.rotation.x, -1.35, Math.min(1, dt * 5));
      root.position.y = THREE.MathUtils.lerp(root.position.y, 0.15, Math.min(1, dt * 5));
    }
  }

  _tickReplay(dt) {
    if (this.cameraMode === 'replay') {
      this.replayT += dt;
      const frames = this.replay.snapshot(60);
      if (frames.length > 0) {
        const idx = Math.min(frames.length - 1, Math.floor((this.replayT / 3.0) * frames.length));
        const snap = frames[idx];
        if (snap) {
          for (const fSnap of snap.fighters) {
            const f = this.fighters.find((x) => x.playerId === fSnap.id);
            if (!f) continue;
            f.rig.root.position.set(fSnap.x, fSnap.y, fSnap.z);
            f.rig.root.rotation.y = fSnap.ry;
            f.rig.root.rotation.x = fSnap.rx;
          }
        }
      }
      if (this.replayT >= 3.2) {
        this.cameraMode = 'ko';
        this.cameraModeT = 0;
      }
    }
  }

  _endMatch(winner, bannerText) {
    this.winner = winner;
    this.phase = 'result';
    this.phaseT = 0;
    // Time-out victory: the winner grins for the result frame.
    const wf = winner ? this.fighters[winner - 1] : null;
    if (wf) { setExpression(wf.rig, 'grin'); wf.expressionT = 0; }
    // Sometimes the decision winner celebrates too.
    this._startCelebration(wf && this.rng.random() < 0.55 ? wf : null);
    this._setBanner(bannerText);
    this._reportResult();
  }

  // ── Victory celebration ───────────────────────────────────────────────
  // Sometimes (~55% of wins) the victor bounces on the spot under the
  // result banner — parabolic hops on the rig root, plus a replay of the
  // personality entrance gesture for flavor. The loser's ragdoll and the
  // frozen camera are untouched. Cleared in _startCountdown.
  _startCelebration(f) {
    this.celebrant = f || null;
    this.celebrationT = 0;
    if (f && f.animator && f.entranceKey && f.state !== 'ko') {
      f.animator.play(f.entranceKey);
    }
  }

  _tickCelebration(dt) {
    const f = this.celebrant;
    if (!f || f.state === 'ko') return;
    this.celebrationT += dt;
    // Ballistic hop arc: period 0.55 s, peak 0.38 m — 4·h·t·(1−t) is the
    // real gravity parabola, so the jumps read as jumps, not a sine bob.
    const HOP_PERIOD = 0.55, HOP_HEIGHT = 0.38;
    const ph = (this.celebrationT % HOP_PERIOD) / HOP_PERIOD;
    f.rig.root.position.y = 4 * HOP_HEIGHT * ph * (1 - ph);
  }

  _reportResult() {
    const name = this.winner === 0
      ? 'DRAW'
      : `${this.fighters[this.winner - 1].rig.config.name.toUpperCase()} WINS!`;
    this._setBanner(name);
    // Per user request: on KO we freeze the camera in 'normal' mode. No
    // replay scrub, no cinematic KO zoom — the fight frame stays exactly
    // where it landed so the player can read the result without their view
    // moving. The mid/perp framing in _updateCamera keeps the same shot.
    this.cameraMode = 'normal';
    this.cameraModeT = 0;
    if (this.dotnet) {
      this.dotnet.invokeMethodAsync('OnMatchEnd', this.winner, Math.round(this.clock * 100) / 100)
        .catch(() => {});
    }
  }

  // ── presentation ────────────────────────────────────────────────────────

  // Place the boom exactly where the spring camera would settle, on the +Z
  // side of the ring, with zero velocity. Used at countdown time: the old
  // reset parked the camera at a fixed (0, 2.4, 7) and let the spring haul it
  // in over the first second of the round, which is a visible lurch — and it
  // lands in the same window as the round's first-frame shader compile, so
  // the two together read as the camera stuttering as the match opens.
  _snapCameraToFraming() {
    if (!this.fighters || this.fighters.length !== 2) return;
    const p1 = this.fighters[0].rig.root.position;
    const p2 = this.fighters[1].rig.root.position;
    const mid = p1.clone().add(p2).multiplyScalar(0.5);
    const axis = p2.clone().sub(p1);
    axis.y = 0;
    const sep = Math.max(axis.length(), 0.5);
    if (axis.lengthSq() > 1e-6) axis.normalize(); else axis.set(1, 0, 0);
    // Same perpendicular the spring boom uses, forced onto the +Z side.
    const perp = new THREE.Vector3(axis.z, 0, -axis.x);
    if (perp.z < 0) perp.negate();
    // Must match the framing maths in _updateCamera's normal branch.
    const distance = THREE.MathUtils.clamp(2.2 + sep * 0.31, 2.5, 5);
    this.camera.position.copy(mid).addScaledVector(perp, distance);
    this.camera.position.y = 1.55 + sep * 0.06;
    this.camera.lookAt(mid.x, mid.y + 1, mid.z);
    this._camVel.set(0, 0, 0);
    this.fovPunch = 0;
    this.shakeT = 0;
    this.camera.fov = this.fovBase;
    this.camera.updateProjectionMatrix();
  }

  _updateCamera(dt) {
    const [f1, f2] = this.fighters;
    const p1 = f1.rig.root.position, p2 = f2.rig.root.position;
    const mid = p1.clone().add(p2).multiplyScalar(0.5);
    const axis = p2.clone().sub(p1);
    axis.y = 0;
    const sep = Math.max(axis.length(), 0.5);
    if (axis.lengthSq() > 1e-6) axis.normalize(); else axis.set(1, 0, 0);

    const perp = new THREE.Vector3(axis.z, 0, -axis.x);
    if (perp.dot(this.camera.position.clone().sub(mid)) < 0) perp.negate();

    // Tight action framing (~80% zoom-in vs. the original 4.5-9 range): the
    // camera rides at a bit over half the old distance so the fighters fill
    // the frame, still pulling back with separation so both stay in shot.
    let distance = THREE.MathUtils.clamp(2.2 + sep * 0.31, 2.5, 5);
    let height = 1.55 + sep * 0.06;
    let lookAt = mid.clone();
    lookAt.y += 1;

    // 2026-07-26 browser audit #3: keep the camera on the audience side of
    // the ring. Without this clamp a fighter ragdolled hard past the
    // ring's edge pushed mid.z to <-3, which made perp.z flip to the
    // -Z side — the spring then settled the camera at z≈-5 with the ring
    // + fighters behind it and the dark backdrop filling the frame. Now
    // perp is forced toward +Z (the audience / camera default), so the
    // camera always looks back across the ring at the action.
    if (perp.z < 0) perp.negate();

    if (this.cameraMode === 'ko') {
      this._camVel.set(0, 0, 0); // hand off cleanly from the spring boom
      const loser = this.fighters.find((f) => f.state === 'ko') || f2;
      const lp = loser.rig.root.position;
      this.cameraModeT += dt;
      const k = 1 - Math.exp(-dt * 2.4);
      if (this.koShot === 'overhead') {
        // Overhead face shot: hover above the falling body — tracking the
        // actual head as the ragdoll drops — descending slowly so the dazed
        // expression fills the frame by the time he lands on the canvas.
        loser.rig.joints.head.getWorldPosition(_koHead);
        const target = new THREE.Vector3(
          _koHead.x + 0.55,
          Math.max(_koHead.y + 1.1, 2.5 - Math.min(0.9, this.cameraModeT * 0.45)),
          // Clamp the Z so an off-the-ring ragdoll doesn't drag the camera
          // behind the action. We keep the camera in front of the loser
          // (audience side: +Z) so the dazed face stays in frame.
          Math.max(_koHead.z + 0.4, RING_HALF + 0.6));
        this.camera.position.lerp(target, k);
        this.camera.lookAt(_koHead.x, _koHead.y, _koHead.z);
        this.camera.fov = this.fovBase - 8 + Math.max(0, 4 - this.cameraModeT * 1.4);
      } else {
        // Cinematic KO shot: low, tight on the loser, slow push-in.
        const axis2 = p1.clone().sub(p2).normalize();
        const camSide = new THREE.Vector3(-axis2.z, 0, axis2.x);
        const target = lp.clone().add(camSide.multiplyScalar(3.0));
        target.y = 1.2;
        // 2026-07-26 browser audit #3: keep the KO cinematic camera
        // inside the ring footprint. Previously a loser ragdolled past the
        // ring edge would pull the camera outside the ring with the loser
        // hidden behind the camera, leaving the dark backdrop on screen.
        target.x = THREE.MathUtils.clamp(target.x, -(RING_HALF + 0.5), RING_HALF + 0.5);
        target.z = THREE.MathUtils.clamp(target.z, -(RING_HALF + 0.5), RING_HALF + 0.5);
        this.camera.position.lerp(target, k);
        this.camera.lookAt(lp.x, 0.3, lp.z);
        this.camera.fov = this.fovBase + Math.max(0, 4 - this.cameraModeT * 1.4);
      }
      this.camera.updateProjectionMatrix();
    } else {
      // Spring-damper camera boom: slightly underdamped, so hard cuts and
      // hit impulses overshoot and settle like a real operator. Directional
      // hit impulses are injected straight into _camVel (_camImpulse).
      const target = mid.clone().add(perp.multiplyScalar(distance));
      target.y = height;
      // 2026-07-26 browser audit #3: clamp the spring target so the
      // camera never settles outside the ring. Even with the perp-flip
      // guard above, mid can wander to ±RING_HALF on X; the camera should
      // still stay within a viewing envelope around the ring.
      target.x = THREE.MathUtils.clamp(target.x, -(RING_HALF + 1.0), RING_HALF + 1.0);
      const sdt = Math.min(dt, 1 / 20);
      const K = 26, C = 8.5;
      this._camVel.x += ((target.x - this.camera.position.x) * K - this._camVel.x * C) * sdt;
      this._camVel.y += ((target.y - this.camera.position.y) * K - this._camVel.y * C) * sdt;
      this._camVel.z += ((target.z - this.camera.position.z) * K - this._camVel.z * C) * sdt;
      this.camera.position.addScaledVector(this._camVel, sdt);
      // Belt-and-braces: hard-clamp the camera position too in case the
      // spring overshoots. The ring is at ±RING_HALF on X; the audience
      // stays on the +Z side.
      this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, -(RING_HALF + 1.0), RING_HALF + 1.0);
      this.camera.position.z = Math.max(this.camera.position.z, 0.2);
      this.camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
    }

    // FOV punch (decays each frame).
    if (this.fovPunch > 0.01) {
      this.camera.fov = this.fovBase + this.fovPunch;
      this.camera.updateProjectionMatrix();
      this.fovPunch *= Math.max(0, 1 - dt * 9);
    } else if (this.cameraMode !== 'ko') {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, this.fovBase, Math.min(1, dt * 6));
      this.camera.updateProjectionMatrix();
    }

    // Screen shake: apply random offset in camera space.
    if (this.shakeT > 0) {
      const amp = this.shakeAmp * (this.shakeT / 0.18);
      this.camera.position.x += (Math.random() - 0.5) * amp;
      this.camera.position.y += (Math.random() - 0.5) * amp;
      this.shakeT = Math.max(0, this.shakeT - dt);
    }
  }

  // ── Touch controls ───────────────────────────────────────────────────
  // Fixed to the bottom of the viewport (the empty strip below the canvas
  // on portrait phones). Left cluster: movement. Right cluster: step-in,
  // block (hold — same tap-vs-hold semantics as the S key), punch, kick
  // (hold to charge). Synthetic key events feed the normal input path.
  _buildTouchControls() {
    const panel = document.createElement('div');
    panel.className = 'pb-touch';
    const mk = (code, label, small = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (small) b.className = 'pb-touch-small';
      const down = (e) => {
        e.preventDefault();
        b.classList.add('pb-touch-held');
        window.dispatchEvent(new KeyboardEvent('keydown', { code }));
        // §7 Haptic tick on press — heavier for strikes (punch/kick) than movement.
        // Bug fix (2026-08-07): skip on kiosk/demo routes — no user gesture
        // means every call below would emit a console error.
        try {
          const onKiosk = (location.search || '').indexOf('kiosk=') >= 0
            || /\/demo(\b|\/|$)/i.test(location.pathname || '');
          if (!onKiosk && (localStorage.getItem('pomini_muted') || '').indexOf('1') === -1 && navigator.vibrate) {
            navigator.vibrate((code === 'KeyF' || code === 'KeyG') ? 16 : 8);
          }
        } catch { }
      };
      const up = () => {
        if (!b.classList.contains('pb-touch-held')) return;
        b.classList.remove('pb-touch-held');
        window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up); // finger slid off = release
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      return b;
    };
    const left = document.createElement('div');
    left.className = 'pb-touch-cluster';
    left.append(mk('KeyA', '◀'), mk('KeyD', '▶'));
    const right = document.createElement('div');
    right.className = 'pb-touch-cluster';
    right.append(mk('KeyW', '⬆', true), mk('KeyS', '🛡', true), mk('KeyF', '👊'), mk('KeyG', '🦵'));
    panel.append(left, right);
    this.container.appendChild(panel);
    this.touchEl = panel;
  }

  // ── Strike trails ────────────────────────────────────────────────────
  // A vertical additive ribbon that follows the striking fist/shoe through
  // the swing arc — brightness ramps toward the head of the trail, and the
  // color goes gold on charged releases. Rebuilt from ≤10 sampled points a
  // frame; the geometry is preallocated once per fighter.
  _makeTrail() {
    const MAX = 10;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 2 * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < MAX - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, points: [], max: MAX, color: new THREE.Color(0xcfe0ff) };
  }

  _updateTrail(f, dt) {
    const t = f.trail;
    if (!t) return;
    const attack = f.attack;
    const swinging = attack && (f.state === 'punch' || f.state === 'kick')
      && f.stateT <= attack.windup + attack.active + 0.08;
    if (swinging) {
      // fistR is unregistered when the right arm is torn off (see _severArm),
      // which can happen mid-swing — there's nothing left to trail.
      const joint = f.rig.joints[f.state === 'kick' ? 'footR' : 'fistR'];
      if (!joint) { t.points.length = 0; t.mesh.visible = false; return; }
      joint.getWorldPosition(_trailPos);
      // Per-point limb speed (idea #9) → drives a velocity motion-blur smear:
      // the faster the fist/foot travels this frame, the wider and hotter the
      // ribbon reads, so a committed strike leaves a real blur, not a thin
      // ribbon. Slow repositioning barely trails at all.
      const prev = t.points[t.points.length - 1];
      let spd = 0;
      if (prev) {
        const dx = _trailPos.x - prev.x, dy = _trailPos.y - prev.y, dz = _trailPos.z - prev.z;
        spd = Math.sqrt(dx * dx + dy * dy + dz * dz) / Math.max(dt, 1e-3);
      }
      t.points.push({ x: _trailPos.x, y: _trailPos.y, z: _trailPos.z, spd });
      if (t.points.length > t.max) t.points.shift();
    } else if (t.points.length) {
      // Swing over: the tail burns off over a few frames.
      t.points.shift();
      if (t.points.length) t.points.shift();
    }
    const n = t.points.length;
    if (n < 2) {
      t.mesh.visible = false;
      t.mesh.geometry.setDrawRange(0, 0);
      return;
    }
    const pos = t.mesh.geometry.attributes.position.array;
    const col = t.mesh.geometry.attributes.color.array;
    for (let i = 0; i < n; i++) {
      const p = t.points[i];
      const a = i / (n - 1);          // 0 tail → 1 head
      // Velocity smear (idea #9): a fast-moving section of the arc widens and
      // brightens toward a motion-blur streak; ~9 m/s saturates the boost.
      const boost = Math.min(1, (p.spd || 0) / 9);
      const w = (0.012 + 0.05 * a) * (1 + boost * 1.7);  // half-width grows to head
      const o = i * 6;
      pos[o] = p.x; pos[o + 1] = p.y - w; pos[o + 2] = p.z;
      pos[o + 3] = p.x; pos[o + 4] = p.y + w; pos[o + 5] = p.z;
      const br = a * a * (0.85 + 0.9 * boost);  // quadratic ramp — hot head, faint tail
      col[o] = col[o + 3] = t.color.r * br;
      col[o + 1] = col[o + 4] = t.color.g * br;
      col[o + 2] = col[o + 5] = t.color.b * br;
    }
    t.mesh.geometry.attributes.position.needsUpdate = true;
    t.mesh.geometry.attributes.color.needsUpdate = true;
    t.mesh.geometry.setDrawRange(0, (n - 1) * 6);
    t.mesh.visible = true;
  }

  // ── GPU particles ────────────────────────────────────────────────────
  // Fixed pool behind one Points mesh. Free slots are a stack of indices;
  // dead particles park at color black (invisible under additive blending).
  _initParticles() {
    const N = this._particleMax = 320;
    this._particlesLive = [];
    this._particleFree = Array.from({ length: N }, (_, i) => N - 1 - i);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    // Soft round sprite so points don't render as squares.
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 1, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    this._particlePoints = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.11, map: new THREE.CanvasTexture(c), vertexColors: true,
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, sizeAttenuation: true, fog: false,
    }));
    this._particlePoints.frustumCulled = false;
    this._particlePoints.renderOrder = 3;
    this.scene.add(this._particlePoints);
  }

  _spawnParticle(x, y, z, vx, vy, vz, color, life, gravity = -8) {
    const i = this._particleFree.pop();
    if (i === undefined) return; // pool exhausted — drop, never grow
    const pos = this._particlePoints.geometry.attributes.position.array;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    const col = new THREE.Color(color);
    this._particlesLive.push({
      i, life, maxLife: life, vx, vy, vz, gravity, r: col.r, g: col.g, b: col.b,
    });
  }

  _updateParticles(dt) {
    if (!this._particlePoints) return;
    const live = this._particlesLive;
    if (!live.length) return;
    const posAttr = this._particlePoints.geometry.attributes.position;
    const colAttr = this._particlePoints.geometry.attributes.color;
    const pos = posAttr.array, col = colAttr.array;
    for (let n = live.length - 1; n >= 0; n--) {
      const p = live[n];
      p.life -= dt;
      const i3 = p.i * 3;
      if (p.life <= 0) {
        col[i3] = col[i3 + 1] = col[i3 + 2] = 0; // additive black = gone
        this._particleFree.push(p.i);
        live[n] = live[live.length - 1];
        live.pop();
        continue;
      }
      p.vy += p.gravity * dt;
      pos[i3] += p.vx * dt;
      pos[i3 + 1] += p.vy * dt;
      pos[i3 + 2] += p.vz * dt;
      const f = p.life / p.maxLife;
      col[i3] = p.r * f; col[i3 + 1] = p.g * f; col[i3 + 2] = p.b * f;
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  _spawnSparks(pos, color, count = 6, power = 1.0) {
    const spread = 0.35 * power;
    for (let i = 0; i < count; i++) {
      const dir = new THREE.Vector3(
        (Math.random() - 0.5),
        Math.random() * 0.8 + 0.2,
        (Math.random() - 0.5)
      ).normalize().multiplyScalar(2.5 + Math.random() * 2.0 * power);
      this._spawnParticle(
        pos.x + (Math.random() - 0.5) * spread,
        pos.y + 1.0 + (Math.random() - 0.5) * 0.3,
        pos.z + (Math.random() - 0.5) * spread,
        dir.x, dir.y, dir.z,
        color, 0.35 + Math.random() * 0.15, -8);
    }
  }

  // Occasional blood on clean face hits: small matte dark-red droplets that
  // arc with the blow and fall under gravity. Deliberately mesh-based with
  // normal blending — additive particles glow, and blood must NOT glow.
  _spawnBlood(pos, dir, power = 1) {
    const count = 4 + Math.round(this.rng.random() * 3 * power);
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.014 + this.rng.random() * 0.02, 5, 4),
        new THREE.MeshBasicMaterial({ color: 0x7e120e, transparent: true, opacity: 0.95 })
      );
      m.position.set(
        pos.x + (this.rng.random() - 0.5) * 0.08,
        pos.y + (this.rng.random() - 0.5) * 0.08,
        pos.z + (this.rng.random() - 0.5) * 0.08);
      const vel = new THREE.Vector3(
        dir.x * (1.2 + this.rng.random() * 1.2) + (this.rng.random() - 0.5) * 1.4,
        0.6 + this.rng.random() * 1.2,
        dir.z * (1.2 + this.rng.random() * 1.2) + (this.rng.random() - 0.5) * 1.4);
      this.scene.add(m);
      // Long life — droplets don't fade in the air; they end by SPLATTING
      // on the canvas (see the blood branch in _updateEffects).
      this.effects.push({ mesh: m, life: 2.5, vel, gravity: -11, blood: true });
    }
  }

  // Can this fighter still throw a punch? The engine only ever swings the RIGHT
  // arm, so a punch needs the right arm attached. (The left arm always tears off
  // first — see _severArm — so a one-armed fighter punches with its right; once
  // the right is gone too it can only kick.)
  _canPunch(f) {
    return !f.armsLost || !f.armsLost.has('R');
  }

  // Tear an arm off the fighter: detach the shoulder→fist group from the torso,
  // reparent the upper arm and forearm into the scene as two independent
  // objects, and hand them to a two-bone rigid-body ragdoll so the limb flops
  // limply to the canvas with a silly blood squirt from stump and limb.
  //
  // Unregistering the arm's joints from `rig.joints` is the load-bearing part:
  // the animator, the KO ragdoll, the hitbox capsules and
  // the hurt-sphere sync all iterate that map and all guard on a missing
  // joint. While the joints stayed registered, every one of those systems kept
  // writing the fighter's live pose onto a limb that was supposed to be lying
  // on the mat — which is why a severed arm went on animating along with its
  // owner instead of going limp.
  //
  // Runs inside cannon's beginContact dispatch (via _handlePhysicsHit), so it
  // must not touch the world — body creation/removal is queued for
  // _buildPendingSevers, which runs outside world.step.
  _severArm(fighter, side, dir) {
    if (!fighter.armsLost) fighter.armsLost = new Set();
    if (fighter.armsLost.has(side)) return;
    const joints = fighter.rig.joints;
    const shoulder = joints['shoulder' + side];
    if (!shoulder || !shoulder.parent) return;
    const elbow = joints['elbow' + side];
    fighter.armsLost.add(side);

    // Snapshot each piece's world transform and re-anchor it in the scene so
    // the arm keeps its on-screen pose the instant it comes off. Order
    // matters: detaching the shoulder first leaves the elbow's world
    // transform unchanged, so its snapshot is still correct.
    const wp = new THREE.Vector3();
    const detach = (obj) => {
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      obj.getWorldPosition(wp);
      obj.getWorldQuaternion(q);
      obj.getWorldScale(s);
      obj.parent.remove(obj);
      obj.position.copy(wp);
      obj.quaternion.copy(q);
      obj.scale.copy(s);
      this.scene.add(obj);
    };
    // Collision boxes are sized off heightScale, exactly like the KO ragdoll's
    // upperArm/forearm parts — not off the sampled world scale, which briefly
    // carries the hips' cartoon-squash factor.
    const scale = (fighter.rig.config && fighter.rig.config.heightScale) || 1;
    detach(shoulder);
    if (elbow && elbow.parent) detach(elbow);
    shoulder.getWorldPosition(wp); // stump position for the blood + audio

    // The limb is no longer part of the fighter: drop its joints so nothing
    // poses it any more.
    delete joints['shoulder' + side];
    delete joints['elbow' + side];
    delete joints['fist' + side];

    // Launch outward (away from the body) + up, with a fast tumble.
    const outward = dir ? dir.clone() : new THREE.Vector3(side === 'L' ? -1 : 1, 0, 0);
    outward.y = 0;
    if (outward.lengthSq() < 1e-4) outward.set(side === 'L' ? -1 : 1, 0, 0);
    outward.normalize();
    const vel = new THREE.Vector3(
      outward.x * (1.6 + this.rng.random() * 1.6) + (side === 'L' ? -1 : 1) * 1.3,
      3.2 + this.rng.random() * 1.6,
      outward.z * (1.6 + this.rng.random() * 1.6));
    const angVel = new THREE.Vector3(
      (this.rng.random() - 0.5) * 11, (this.rng.random() - 0.5) * 11, (this.rng.random() - 0.5) * 13);

    const limb = { shoulder, elbow: elbow || null, scale, vel, angVel, arm: null, restT: 0, settled: false };
    this._severedLimbs = this._severedLimbs || [];
    this._severedLimbs.push(limb);
    this._pendingSevers = this._pendingSevers || [];
    this._pendingSevers.push({ fighter, side, limb });

    // Silly geyser: a big squirt off the stump + a burst trailing the limb.
    this._bloodSquirt(wp, outward, 2.4);
    this._bloodSquirt(wp, new THREE.Vector3(outward.x, 1, outward.z).normalize(), 1.8);
    // Keep the stump bleeding for a beat (see the stump loop in _tick).
    fighter.stumps.push({ side, t: 1.4, emit: 0 });
    this.audio.impact({ power: 1.8, worldPos: wp });
    this.hudDirty = true;
  }

  // Deferred half of _severArm: build the limb's rigid bodies and retire the
  // arm's hurt spheres. Called right after every stepWorld, so we're always
  // outside cannon's step when bodies are added or removed.
  _buildPendingSevers() {
    if (!this._pendingSevers || !this._pendingSevers.length) return;
    if (!this._physics) { this._pendingSevers.length = 0; return; }
    const world = this._physics.world;
    for (const p of this._pendingSevers) {
      // The arm's hurt capsules go with it — otherwise their spheres stay
      // frozen mid-air (the sync skips them now that the joints are gone) and
      // keep registering hits on a body part that isn't there any more.
      const fp = p.fighter.fighterPhysics;
      if (fp) {
        const dead = new Set();
        for (const s of fp.hurtSpheres) {
          const cap = (s.userData.jointName || '').split(':')[0];
          if (cap === 'upperArm' + p.side || cap === 'forearm' + p.side) dead.add(s);
        }
        for (const c of fp.constraints.slice()) {
          if (!dead.has(c.bodyA) && !dead.has(c.bodyB)) continue;
          if (world.constraints.includes(c)) world.removeConstraint(c);
          fp.constraints.splice(fp.constraints.indexOf(c), 1);
        }
        for (const s of dead) {
          if (world.bodies.includes(s)) world.removeBody(s);
          fp.hurtSpheres.splice(fp.hurtSpheres.indexOf(s), 1);
        }
      }
      // Losing the right arm mid-swing orphans that swing's striker spheres —
      // the sync skips them once fistR is gone, so they'd sit frozen in the
      // air still dealing hits. Retire the swing with the limb.
      if (p.side === 'R' && p.fighter.swingPhysics && p.fighter.state === 'punch') {
        this._destroySwingPhysics(p.fighter);
      }
      p.limb.arm = new SeveredArm(world, this._physics.materials.ragdoll, {
        shoulder: p.limb.shoulder,
        elbow: p.limb.elbow,
        scale: p.limb.scale,
        velocity: p.limb.vel,
        angularVelocity: p.limb.angVel,
      });
    }
    this._pendingSevers.length = 0;
  }

  // A beefier, sillier version of _spawnBlood for a dismemberment geyser: more
  // droplets, launched harder. Reuses the blood/stain pipeline so it splats.
  _bloodSquirt(pos, dir, power = 1) {
    const count = 10 + Math.round(this.rng.random() * 10 * power);
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.02 + this.rng.random() * 0.03, 5, 4),
        new THREE.MeshBasicMaterial({ color: 0x9e120e, transparent: true, opacity: 0.95 })
      );
      m.position.set(
        pos.x + (this.rng.random() - 0.5) * 0.1,
        pos.y + (this.rng.random() - 0.5) * 0.1,
        pos.z + (this.rng.random() - 0.5) * 0.1);
      const vel = new THREE.Vector3(
        dir.x * (2.2 + this.rng.random() * 2.6) + (this.rng.random() - 0.5) * 2.2,
        1.6 + this.rng.random() * 2.6 * power,
        dir.z * (2.2 + this.rng.random() * 2.6) + (this.rng.random() - 0.5) * 2.2);
      this.scene.add(m);
      this.effects.push({ mesh: m, life: 2.5, vel, gravity: -11, blood: true });
    }
  }

  // Drive each severed arm from its rigid bodies. The limb is limp the whole
  // way down — cannon owns gravity, the bounce off the canvas, the friction
  // slide and the flop at the elbow — and once it has come to rest we retire
  // its bodies and leave the meshes lying where they landed. (The world has
  // allowSleep = false, so a settled limb would otherwise jitter on solver
  // noise forever.) Limbs linger until the next match clears them
  // (_spawnFighters).
  _updateSeveredLimbs(dt) {
    if (!this._severedLimbs || !this._severedLimbs.length) return;
    for (const l of this._severedLimbs) {
      if (l.settled || !l.arm || !l.arm.active) continue;
      l.arm.drive();
      l.restT = l.arm.speed < 0.4 ? l.restT + dt : 0;
      if (l.restT > 0.4) {
        l.settled = true;
        const p = l.shoulder.position;
        l.arm.dispose();
        if (Math.abs(p.x) < 5.7 && Math.abs(p.z) < 5.7) {
          this._addBloodStain(p.x, p.z);
        }
      }
    }
  }

  // A landed droplet becomes a permanent stain on the canvas — the ring
  // visibly accumulates the fight's damage until the next match clears it.
  _addBloodStain(x, z) {
    if (!this._stainGeo) {
      this._stainGeo = new THREE.CircleGeometry(1, 8);
      this._stainMat = new THREE.MeshBasicMaterial({
        color: 0x5e0d0a, transparent: true, opacity: 0.8, depthWrite: false,
      });
    }
    this._bloodStains = this._bloodStains || [];
    // Cap the pool: the oldest stain recycles once the canvas is saturated.
    if (this._bloodStains.length >= 160) {
      const old = this._bloodStains.shift();
      this.scene.remove(old);
      this._bloodStains.push(old);
      old.position.set(x, 0.048, z);
      old.rotation.z = this.rng.random() * Math.PI;
      this.scene.add(old);
      return;
    }
    const s = new THREE.Mesh(this._stainGeo, this._stainMat);
    s.rotation.x = -Math.PI / 2;
    s.rotation.z = this.rng.random() * Math.PI;
    const r = 0.03 + this.rng.random() * 0.055;
    s.scale.set(r * (1 + this.rng.random() * 0.6), r, 1);
    s.position.set(x, 0.048, z);
    s.renderOrder = 2; // above the canvas top
    this.scene.add(s);
    this._bloodStains.push(s);
  }

  // Sweat spray off a rocked fighter's head on the heavy-hit stagger.
  _spawnSweat(headPos, count = 7) {
    for (let i = 0; i < count; i++) {
      this._spawnParticle(
        headPos.x + (Math.random() - 0.5) * 0.2,
        headPos.y + 0.1 + Math.random() * 0.15,
        headPos.z + (Math.random() - 0.5) * 0.2,
        (Math.random() - 0.5) * 3.2, 1.2 + Math.random() * 1.6, (Math.random() - 0.5) * 3.2,
        0xbfd8ff, 0.4 + Math.random() * 0.2, -9);
    }
  }

  // Celebration confetti glitter over the ring at the K.O.
  _spawnConfetti() {
    const colors = [0xff4a3c, 0x4a7dff, 0xffd257, 0xf5f2ec];
    for (let i = 0; i < 80; i++) {
      this._spawnParticle(
        (Math.random() - 0.5) * 7, 5.5 + Math.random() * 2.5, (Math.random() - 0.5) * 7,
        (Math.random() - 0.5) * 0.8, -0.4 - Math.random() * 0.5, (Math.random() - 0.5) * 0.8,
        colors[(Math.random() * colors.length) | 0],
        2.2 + Math.random() * 1.4, -0.35);
    }
  }

  _updateEffects(dt) {
    this._updateParticles(dt);
    this._updateSeveredLimbs(dt);
    // The mesh-based list below carries post debris chunks + blood droplets.
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life -= dt;
      const mesh = e.mesh;
      // Blood splats on the canvas instead of fading mid-air.
      if (e.blood && mesh.position.y <= 0.07 && e.vel && e.vel.y < 0) {
        if (Math.abs(mesh.position.x) < 5.7 && Math.abs(mesh.position.z) < 5.7) {
          this._addBloodStain(mesh.position.x, mesh.position.z);
        }
        e.life = 0; // fall through to the removal branch below
      }
      if (e.vel) {
        mesh.position.x += e.vel.x * dt;
        mesh.position.y += e.vel.y * dt;
        mesh.position.z += e.vel.z * dt;
        e.vel.y += (e.gravity ?? 0) * dt;
      }
      if (e.angVel) {
        mesh.rotation.x += e.angVel.x * dt;
        mesh.rotation.y += e.angVel.y * dt;
        mesh.rotation.z += e.angVel.z * dt;
      }
      if (!e.vel) mesh.scale.multiplyScalar(1 + dt * 10);
      mesh.material.opacity = Math.max(0, e.life / 0.35);
      if (e.life <= 0) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        this.effects.splice(i, 1);
      }
    }
  }

  _updateCrowd(dt) {
    animateCrowd(this.arena.crowd, dt, this.clock, this.excited);
    this.excited = Math.max(0, this.excited - dt * 0.4);
  }

  _setBanner(text) {
    if (this.banner && this.banner.textContent !== text) this.banner.textContent = text;
  }

  _pushHud(dt) {
    this.hudTimer += dt;
    if (!this.hudDirty && this.hudTimer < 0.25) return;
    this.hudTimer = 0;
    this.hudDirty = false;
    if (this.dotnet) {
      // Region damage rides along as [head, torso, arms, legs] per fighter so
      // the Blazor HUD can render the body-diagram damage readout.
      const regions = (f) => [
        Math.round(f.regionDmg.head), Math.round(f.regionDmg.torso),
        Math.round(f.regionDmg.arms), Math.round(f.regionDmg.legs),
      ];
      this.dotnet.invokeMethodAsync('OnHud',
        this._hp(this.fighters[0]), this._hp(this.fighters[1]), Math.round(this.clock * 10) / 10,
        regions(this.fighters[0]), regions(this.fighters[1]),
        Math.round(this.fighters[0].energy * 100), Math.round(this.fighters[1].energy * 100),
        // Super meter (0..100) per fighter + 1/0 "ready" flag for the HUD
        // to show the "PRESS E/O" prompt when full.
        Math.round((this.fighters[0].superMeter || 0) * 100),
        Math.round((this.fighters[1].superMeter || 0) * 100),
        (this.fighters[0].superMeter || 0) >= 1.0 ? 1 : 0,
        (this.fighters[1].superMeter || 0) >= 1.0 ? 1 : 0)
        .catch(() => {});
    }
  }

  setMuted(m) {
    this.muted = !!m;
    this.audio.setMuted(this.muted);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this._onResize);
    if (this.touchEl) this.touchEl.remove();
    if (this.fighters) for (const f of this.fighters) f.controller.dispose();
    if (this.audio) this.audio.close();
    // Drop any swing physics and per-fighter bodies, then dispose the world.
    if (this.props) { disposeProps(this.props); this.props = null; }
    if (this.fighters) {
      for (const f of this.fighters) {
        if (f.swingPhysics) destroySwingPhysics(this._physics.world, f.swingPhysics);
        this._removeFighterPhysics(f);
        if (f.koRagdoll) f.koRagdoll.dispose();
      }
    }
    this._physics = null;
    // Before the traverse: a Reflector's render target is invisible to a
    // geometry/material walk. See disposeArenaReflector.
    disposeArenaReflector();
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) m.dispose();
        }
      });
    }
    if (this.composer) this.composer.dispose?.();
    if (this._blobTex) this._blobTex.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    if (this.banner) this.banner.remove();
    if (this.flash) this.flash.remove();
    this.dotnet = null;
  }
}