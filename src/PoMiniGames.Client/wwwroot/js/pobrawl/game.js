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
import { buildArena, animateCrowd, updateAtmosphere, updateRopes, twangRope, damagePost, RING_HALF } from './arena.js';
import { buildFighter, updateJiggles, setExpression, CHARACTERS, CHARACTER_IDS } from './fighters.js';
import { Animator } from './animation.js';
import { KeyboardController } from './input.js';
import { AiController } from './ai.js';
import { RandomGenerator } from './rng.js';
import { CombatPlay, COMBAT_EVENTS, REGIONS, regionEffect } from './combat.js';
import { AudioBus } from './audio.js';
import { ReplayBuffer } from './replay.js';
import { PoBrawlRagdoll } from './ragdoll.js';
import { CannonRagdoll } from './ragdoll-physics.js';
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
// empty → CHARGE_MAX_MUL when full). It fills while holding punch/kick (the
// charge state) and jumps +25% per successfully blocked hit; passive regen
// only works while idle and tops out at half power — banking more than 50%
// takes active defense or a held wind-up.
const ENERGY_IDLE_CAP = 0.5;
const ENERGY_REGEN = 0.12;        // per second, idle state only, up to the cap
const ENERGY_BLOCK_REWARD = 0.25; // per blocked hit, up to 1

// Fighters never leave their feet before the final blow — heavy hits get a
// hard stagger (extra knockback + lean) instead of a mid-fight knockdown.
// The KO ragdoll is the only way to the canvas.
const HEAVY_HIT_DMG = 13; // threshold for the amplified stagger reaction (¼ of the old 50, matching the ¼ damage table)
const DOWN_TIME = 1.15;   // (legacy 'down' state, no longer triggered)
const GETUP_TIME = 0.6;   // (legacy 'getup' state, no longer triggered)

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
    varying vec2 vUv;
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

      // Broadcast grade: teal-pushed shadows, warm highlights, +saturation.
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += vec3(0.008, 0.02, 0.038) * (1.0 - smoothstep(0.0, 0.4, lum)) * uGrade;
      col *= mix(vec3(1.0), vec3(1.05, 1.0, 0.93), smoothstep(0.3, 1.0, lum) * uGrade);
      col = mix(vec3(lum), col, 1.0 + 0.1 * uGrade);

      // KO drain: desaturate except strong reds (blood-red trim, red corner).
      if (uDesat > 0.003) {
        float keepRed = smoothstep(0.1, 0.4, col.r - max(col.g, col.b));
        vec3 drained = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, keepRed);
        col = mix(col, drained, uDesat);
      }

      float d = distance(vUv, vec2(0.5));
      col *= 1.0 - smoothstep(0.55, 0.95, d) * uVignette;
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
    // Post-processing quality tier: 2 = full (MSAA×4 + GTAO + bloom + CA),
    // 1 = medium (MSAA×2 + bloom + CA), 0 = low (bare render, pixel ratio 1).
    // Starts at full and steps DOWN automatically when sustained FPS can't
    // hold the 60 Hz sim — low framerate hurts a timing game more than any
    // post pass helps it. options.quality (0|1|2) pins a tier and disables
    // the auto stepdown.
    this._qualityForced = !!(options && Number.isInteger(options.quality));
    this.quality = this._qualityForced ? Math.max(0, Math.min(2, options.quality)) : 2;
    this._lowFpsStreak = 0;
    this._fpsSampleCount = 0;
  }

  start() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 540;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    // PCFSoft: percentage-closer soft edges — the fighters' shadows get a
    // real penumbra instead of the stepped PCF look.
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // AgX handles saturated bright lights (bloom pulses, colored corner
    // accents) far more gracefully than ACES, which skews hot colors.
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.exposureBase = 1.15;
    this.renderer.toneMappingExposure = this.exposureBase;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // PBR env map: a tiny PMREMGenerator scene with hemisphere + key + rim
    // produces a usable IBL without needing to ship an HDR file.
    this.envMap = this._makeEnvMap();
    this.arena = buildArena(this.scene, this.envMap);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 100);
    this.camera.position.set(0, 2.4, 7);
    if (this.envMap) {
      this.scene.environment = this.envMap;
      // The arena-proxy bake is moodier than RoomEnvironment was, so the
      // ambient IBL can run a little hotter without washing out the hall.
      this.scene.environmentIntensity = 0.55;
    }

    // Post chain: render → (GTAO) → (bloom → CA/vignette) → tone-map/sRGB
    // output, assembled per quality tier (see _buildComposer).
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

    this.banner = document.createElement('div');
    this.banner.className = 'pb-banner';
    this.container.appendChild(this.banner);

    // FPS badge, upper-right. Updated twice a second from the render loop.
    this.fpsEl = document.createElement('div');
    this.fpsEl.className = 'pb-fps';
    this.container.appendChild(this.fpsEl);
    this._fpsFrames = 0;
    this._fpsTime = 0;

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
    };
    window.addEventListener('resize', this._onResize);

    // Build the physics world before spawning fighters — per-fighter bodies
    // (kinematic rig-root + dynamic hurt spheres) are created in _spawnFighters.
    this._physics = createPhysicsWorld();
    this._setupPhysicsCollisions();
    // Static post/rope colliders — only the KO ragdoll interacts with them.
    buildArenaColliders(this._physics.world, this._physics.materials);
    this._spawnFighters(this.options.p1Character, this.options.p2Character);
    this._startCountdown();

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

      // Quality monitor — measured from the unclamped frame delta so slow
      // frames report honestly (dt is clamped for the sim). The FPS number
      // itself lives in the shared top-bar badge (FpsCounter); the in-canvas
      // badge only surfaces the FX tier when the monitor has stepped down.
      this._fpsFrames++;
      this._fpsTime += rawDt;
      if (this._fpsTime >= 0.5) {
        const fps = Math.round(this._fpsFrames / this._fpsTime);
        this._tickQualityMonitor(fps);
        const label = this.quality < 2 ? `FX ${this.quality === 1 ? 'med' : 'low'}` : '';
        if (this.fpsEl && this.fpsEl.textContent !== label) this.fpsEl.textContent = label;
        this._fpsFrames = 0;
        this._fpsTime = 0;
      }
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
      updateRopes(this.arena, dt, this.fighters);
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

  // Build (or rebuild) the post chain for the current quality tier.
  //   tier 2: MSAA×4 target, GTAO, bloom, CA/vignette — full look
  //   tier 1: MSAA×2 target, bloom, CA/vignette — GTAO is the priciest pass
  //   tier 0: plain render target, no bloom/CA, pixel ratio 1 — gameplay only
  // All render-loop consumers guard on this.bloomPass/this.fxPass, so dropped
  // passes simply stop pulsing.
  _buildComposer(w, h) {
    if (this.composer) {
      // EffectComposer.dispose() only frees its own targets — passes (GTAO's
      // internal buffers, bloom's mip chain) must be disposed explicitly.
      for (const p of this.composer.passes) p.dispose?.();
      try { this.composer.dispose(); } catch { /* already gone */ }
    }
    this.bloomPass = null;
    this.fxPass = null;

    const q = this.quality;
    const pixelRatio = q === 2 ? Math.min(window.devicePixelRatio, 2)
      : q === 1 ? Math.min(window.devicePixelRatio, 1.5)
      : 1;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h);

    // Bloom threshold sits just under the spark/hit-flash luminance so
    // impacts glow while the arena itself stays clean.
    // MSAA render target — the composer's default target has no samples,
    // which would drop the AA the raw canvas had.
    const composerRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: q === 2 ? 4 : q === 1 ? 2 : 0,
    });
    this.composer = new EffectComposer(this.renderer, composerRT);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (q === 2) {
      // Ground-truth AO: contact-level darkening in armpits, under ropes and
      // between crowd rows that flat hemisphere ambient destroys.
      try {
        const gtao = new GTAOPass(this.scene, this.camera, w, h);
        gtao.output = GTAOPass.OUTPUT.Default;
        gtao.blendIntensity = 0.85;
        this.composer.addPass(gtao);
      } catch { /* AO is a nicety — never block the game on it */ }
    }
    if (q >= 1) {
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.32, 0.55, 0.8);
      this.composer.addPass(this.bloomPass);
      this.fxPass = new ShaderPass(CAVignetteShader);
      this.composer.addPass(this.fxPass);
    }
    this.composer.addPass(new OutputPass());
  }

  // Auto quality stepdown, fed a sample every 0.5 s by the render loop. The
  // first ~2 s are ignored (shader warm-up skews them); after that, four
  // consecutive samples under 45 FPS drop one tier. Down only — stepping back
  // up would oscillate at the boundary.
  _tickQualityMonitor(fps) {
    if (this._qualityForced || this.quality <= 0) return;
    this._fpsSampleCount++;
    if (this._fpsSampleCount <= 4) return;
    if (fps >= 45) {
      this._lowFpsStreak = 0;
      return;
    }
    if (++this._lowFpsStreak >= 4) {
      this.quality--;
      this._lowFpsStreak = 0;
      this._buildComposer(
        this.container.clientWidth || 800, this.container.clientHeight || 540);
      console.info(`[PoBrawl] sustained low FPS — post FX stepped down to tier ${this.quality}`);
    }
  }

  _makeEnvMap() {
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      // Scene-matched IBL: a tiny proxy of OUR arena (dark hall, warm key
      // rig overhead, cool rim panel, red/blue corner glows, violet canvas
      // bounce below) baked to PMREM. Every specular highlight now reflects
      // the actual venue — fighters near the red corner pick up red rim
      // light in their speculars with no extra runtime lights. HDR values
      // (colors > 1) are fine: PMREM renders to a half-float target.
      const env = new THREE.Scene();
      const bx = (w, h, d, color, intensity, x, y, z) => {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, d),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) }));
        m.position.set(x, y, z);
        env.add(m);
        return m;
      };
      // Dark hall shell.
      const shell = new THREE.Mesh(
        new THREE.BoxGeometry(40, 24, 40),
        new THREE.MeshBasicMaterial({ color: 0x07080f, side: THREE.BackSide }));
      shell.position.y = 8;
      env.add(shell);
      // Warm key rig overhead (matches the directional key at 6,12,4).
      bx(8, 0.5, 8, 0xfff1d0, 9, 4, 11, 3);
      // Cool rim panel (matches the blue rim at -5,6,-6).
      bx(7, 5, 0.5, 0x6070ff, 3.5, -6, 6, -9);
      // Red / blue corner glows (matching the corner PointLights + trim).
      bx(1.5, 2.5, 1.5, 0xff3b30, 4, -8, 1.5, 0);
      bx(1.5, 2.5, 1.5, 0x3b6bff, 4, 8, 1.5, 0);
      // Violet canvas bounce from below.
      bx(14, 0.5, 14, 0x3d4680, 1.4, 0, -1.5, 0);
      const tex = pmrem.fromScene(env, 0.04).texture;
      pmrem.dispose();
      env.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      return tex;
    } catch {
      return null;
    }
  }

  _makeController(playerIndex) {
    const mode = this.options.mode;
    const difficulty = this.options.difficulty || 'medium';
    if (mode === 'demo') return new AiController(difficulty, this.rng);
    if (mode === '2p') return new KeyboardController(playerIndex);
    return playerIndex === 1 ? new KeyboardController(1) : new AiController(difficulty, this.rng);
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

    this.combat = new CombatPlay({ maxHealth: MAX_HP });
    this.replay.start();

    this.fighters = [1, 2].map((index) => {
      const charId = index === 1 ? p1Char : p2Char;
      const rig = buildFighter(CHARACTERS[charId] ? charId : CHARACTER_IDS[0]);
      rig.root.position.set(index === 1 ? -1.6 : 1.6, 0, 0);
      this.scene.add(rig.root);
      const playerId = `p${index}`;
      this.combat.addPlayer({ playerId, teamId: String(index) });

      // Build cannon-es bodies for this fighter. The kinematic rig-root
      // handles push-apart with the opponent; the dynamic hurt spheres +
      // DistanceConstraints are what the strikers collide with.
      const initialXZ = { x: rig.root.position.x, z: rig.root.position.z };
      const fighterPhysics = buildFighterPhysics(this._physics.world, this._physics.materials, { rig }, initialXZ);

      // Soft contact shadow: a radial-gradient blob that tracks the hips and
      // widens/darkens as the body drops. Sells grounding far better than
      // the directional shadow map alone.
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

      return {
        index,
        playerId,
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
        energy: ENERGY_IDLE_CAP, // 0..1 banked attack power (see ENERGY_* consts)
        chargeCued: false, // full-charge audio cue fired
        chargeSparkT: 0,   // spark-mote emission timer
        // ── Momentum + weight ─────────────────────────────────────────
        vel: new THREE.Vector3(),
        targetVel: new THREE.Vector3(),
        knockback: new THREE.Vector3(),
        sideVel: new THREE.Vector3(),
        // ── Per-region damage ─────────────────────────────────────────
        regionDmg: { head: 0, torso: 0, arms: 0, legs: 0 },
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
        hpCur: MAX_HP,
        // Impact feedback: cartoon squash timer (shape only — per user request
        // the model's colors never change on hits or KO).
        squashT: 0,
        // Soft contact-shadow mesh (tracks the hips each frame).
        blob,
        // Additive swing ribbon following the striking limb.
        trail: this._makeTrail(),
        // Track the last frame's windup flag for the AI to read.
        lastWasWindup: false,
        // Verlet ragdoll — the soft, recoverable flop used for knockdowns.
        ragdoll: new PoBrawlRagdoll(rig.joints, rig.root),
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
  }

  _hp(f) {
    return Math.max(0, Math.round(this.combat.getPlayer(f.playerId).health));
  }

  _startCountdown() {
    this.phase = 'countdown';
    this.phaseT = 0;
    this.clock = 0;
    this.winner = 0;
    // Land the previous match's celebrant before the fresh countdown.
    if (this.celebrant) this.celebrant.rig.root.position.y = 0;
    this.celebrant = null;
    this.pendingCelebration = null;
    this.celebrationT = 0;
    this.timeScale = 1;
    this.cameraMode = 'normal';
    this.cameraModeT = 0;
    // Kick the personality entrance for each fighter. The track lasts ~1.5 s
    // (3-4 keyframes); the countdown is 3.7 s, so the entrance resolves to
    // GUARD before FIGHT! fires and the match starts clean.
    if (this.fighters) {
      for (const f of this.fighters) {
        if (f.animator && f.entranceKey) f.animator.play(f.entranceKey);
      }
    }
    this._setBanner('3');
  }

  resetMatch(randomize) {
    let p1 = this.options.p1Character, p2 = this.options.p2Character;
    if (randomize) {
      const ids = this.rng.shuffle(CHARACTER_IDS);
      [p1, p2] = ids;
    }
    this._spawnFighters(p1, p2);
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
      f.animator.update({
        dt, speed: f.speedAmt, idleT: f.idleT,
        root: f.rig.root,
        vel: _animVel.set(f.vel.x + f.knockback.x, 0, f.vel.z + f.knockback.z),
      });
      f.animator.decayLean(dt);
      f.hpCur = this._hp(f);

      // Knockdown ragdoll runs during regular play (KO ragdoll is stepped
      // by _tickKoFall so it survives the slow-mo phases).
      if (f.state === 'down' && f.ragdoll && f.ragdoll.active) f.ragdoll.step(dt);

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
      const intent = f.controller.update(ctx);
      this._tickFighter(f, opp, intent, dt);
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
      if (pos.x !== rawX && Math.abs(f.knockback.x) > 1.5) {
        const power = Math.min(2, Math.abs(f.knockback.x) / 4);
        f.knockback.x *= -0.65; // springy ropes
        f.animator.applyLean(0, rawX > 0 ? 0.35 : -0.35);
        f.animator.applyReaction('torso', -2.5, 0, 0);
        twangRope(this.arena, 'x', rawX > 0 ? 1 : -1, power);
      }
      if (pos.z !== rawZ && Math.abs(f.knockback.z) > 1.5) {
        const power = Math.min(2, Math.abs(f.knockback.z) / 4);
        f.knockback.z *= -0.65;
        f.animator.applyLean(rawZ > 0 ? -0.35 : 0.35, 0);
        f.animator.applyReaction('torso', -2.5, 0, 0);
        twangRope(this.arena, 'z', rawZ > 0 ? 1 : -1, power);
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
      if (f.state !== 'ko' && f.state !== 'down') {
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
      kickRange: ATTACKS.kick.reach * opp.rig.config.heightScale + 0.3,
      opponentWindup: oppInWindup,
      opponentActive: oppInActive,
      opponentRecover: oppInRecover,
      opponentState: opp.state,
      ownAttacks: ATTACKS,
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
    const incapacitated = f.state === 'ko' || f.state === 'down' || f.state === 'getup';
    // Charging roots the fighter — all the weight is loaded into the coil.
    const rooted = f.state === 'charge';
    if (intent.move !== 0 && !incapacitated && !rooted) {
      const toward = opp.rig.root.position.clone().sub(pos);
      toward.y = 0;
      if (toward.lengthSq() > 1e-6) toward.normalize();
      desired.add(toward.multiplyScalar(intent.move * moveSpeed * effect.moveMul));
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
        // Passive energy regen — idle only, capped at half power.
        if (f.energy < ENERGY_IDLE_CAP) {
          f.energy = Math.min(ENERGY_IDLE_CAP, f.energy + ENERGY_REGEN * dt);
        }
        if (intent.punch || intent.kick) {
          const name = intent.punch ? 'punch' : 'kick';
          this._enterCharge(f, name);
          break;
        }
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
        if (intent.punch && f.stateT >= a.cancelInto.punch) this._enterCharge(f, 'punch');
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
      case 'down': {
        // Knocked down: the partial ragdoll owns the body (stepped in _tick).
        // Invulnerable until the get-up completes — _tryHit early-outs on us.
        // Swing teardown happens here (outside the physics step) — see the
        // note in _tryHit's knockdown block.
        this._destroySwingPhysics(f);
        if (f.stateT >= DOWN_TIME) {
          f.state = 'getup';
          f.stateT = 0;
          f.animator.frozen = false;
          f.animator.setBlocking(false);
          f.ragdoll.dispose();
        }
        break;
      }
      case 'getup': {
        // Scramble back to guard: the animator (unfrozen) damp-lerps the
        // joints from the ragdoll pose to GUARD while we slide the root
        // back up to standing height.
        f.rig.root.position.y = THREE.MathUtils.lerp(f.rig.root.position.y, 0, Math.min(1, dt * 8));
        if (f.stateT >= GETUP_TIME) {
          f.state = 'idle';
          f.stateT = 0;
          f.rig.root.position.y = 0;
        }
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
    f.state = name;
    f.stateT = 0;
    f.hasHit = false;
    f.attack = ATTACKS[name];
    f.chargeName = null;
    f.chargeMul = 1 + (CHARGE_MAX_MUL - 1) * chargeAmt;
    // Spend-it-all: the swing consumes the whole energy pool. Regen crawls
    // back toward the 50% idle cap; blocks are the fast way to reload.
    f.energy = 0;
    this.hudDirty = true;
    f.animator.play(name);
    // Trail color: cool steel normally, hot gold on a charged release —
    // "charged" now means above the ENERGY_IDLE_CAP baseline, so gold still
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
        const lunge = (name === 'kick' ? 2.2 : 1.8) * (1 + 1.4 * chargeAmt);
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
    this.radialPulse = Math.max(this.radialPulse, 0.45);
    this.caPulse = Math.max(this.caPulse, 0.5);
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
    // A downed (or already-KO'd) body is invulnerable — the knockdown is the
    // punish; wailing on a ragdoll would read as unfair and looks broken.
    if (defender.state === 'down' || defender.state === 'ko') return;

    const phase = (attacker.stateT > attack.windup + attack.active) ? 'recover' : 'active';
    const hit = testAttackHit(attacker.rig, attack.name, phase, defender.rig);
    if (!hit) return;

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
    const blocked = defender.state === 'block' &&
                    testAttackBlocked(attacker.rig, attack.name, phase, defender.rig);
    if (blocked) {
      // Successful block banks energy — the defender's counter gets stronger.
      defender.energy = Math.min(1, defender.energy + ENERGY_BLOCK_REWARD);
      this.hudDirty = true;
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
    const baseDmg = (attack.dmg * chargeMul + this.rng.randint(-1, 1))
      * effect.atkMul * regionMod * powerScale;
    this.combat.damage({ playerId: defender.playerId, amount: baseDmg, sourceId: attacker.playerId });
    // Getting tagged mid-charge dumps the stored charge — that's the risk.
    // (Energy banked while idle/blocking survives a hit; only an interrupted
    // wind-up loses the pool.)
    if (defender.state === 'charge') defender.energy = 0;
    defender.state = 'hitstun';
    defender.stateT = 0;
    defender.chargeName = null;
    defender.chargeAmt = 0;
    defender.animator.setCharge(null, 0);
    defender.animator.setBlocking(false);
    defender.animator.play('hitstun');
    defender.knockback.add(knockDir.clone().multiplyScalar(4.5 * chargeMul * (atkMass / defMass)));
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
    // diagram and the sweat/swell wear — never the model's colors).
    defender.regionDmg[region] = Math.min(100, defender.regionDmg[region] + Math.max(2, baseDmg));
    this._applyDamageWear(defender);

    // Facial reaction: a grimace held briefly, then back to the resting face.
    setExpression(defender.rig, 'hurt');
    defender.expressionT = 0.7;

    if (defender.controller.notifyHit) defender.controller.notifyHit();
    // Sparks + a real light flash at the contact point, not at the defender's root.
    this._spawnSparks(hit.point, region === REGIONS.HEAD ? 0xff5530 : 0xffc857,
      Math.round(8 * chargeMul), 1.4 * chargeMul);
    // Roughly 1-in-4 face hits draw blood; charged shots more often.
    if (region === REGIONS.HEAD && this.rng.random() < 0.22 + 0.3 * (chargeMul - 1)) {
      this._spawnBlood(hit.point, impulseDir, chargeMul);
    }
    this._flashImpactLight(hit.point, (attack.name === 'kick' ? 10 : 6) * chargeMul);
    this._hitFeedback(attack, true, chargeMul);
    // Directional camera kick: the boom takes the hit's impulse and the
    // spring settles it — the camera is knocked the way the fighter is.
    this._camVel.addScaledVector(impulseDir,
      (attack.name === 'kick' ? 1.5 : 0.9) * chargeMul);
    this._camVel.y += 0.35 * chargeMul;
    this.audio.impact({ power: Math.min(2, baseDmg / 3), worldPos: hit.point });
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
        this.caPulse = 1.8;
        this.bloomPulse = 1.4;
        this.exposurePulse = 0.35;
        // Big warm flash over the fallen fighter as the house lights dim.
        this._flashImpactLight(
          new THREE.Vector3(dpos.x, dpos.y + 1.0, dpos.z), 22, 0xfff0d0, 0.4);
        this.excited = 1;
        this._spawnConfetti();
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
    }
  }

  // Accumulating damage wear — SHAPE AND SHINE ONLY. Per user request the
  // model's colors never change when a fighter is hit or knocked out: no
  // bruise tints, no emissive hit-flash, no cut decal. Damage is read from
  // the HUD body diagram instead. What remains here is sweat glisten
  // (roughness drops — the fighter gets shinier as the fight wears on) and
  // cheek/brow swelling, both frozen once the fighter is down/KO'd so the
  // fallen silhouette stays consistent under the result modal.
  _applyDamageWear(f) {
    if (f.state === 'ko' || f.state === 'down') return;
    const total = (f.regionDmg.head + f.regionDmg.torso
      + f.regionDmg.arms + f.regionDmg.legs) / 400;
    const sweat = Math.min(1, total * 1.6);
    f.rig.materials.skinMat.roughness = 0.55 - 0.3 * sweat;
    f.rig.materials.suitMat.roughness = 0.95 - 0.3 * sweat;
    // The face has its own materials now (tinted skin + painted detail
    // plate) — they glisten with the rest of the skin.
    if (f.rig.materials.faceMat) f.rig.materials.faceMat.roughness = 0.55 - 0.3 * sweat;
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
    // Post-FX spike: bloom flares, the frame fringes, and the exposure
    // "blooms open" for a beat on heavy hits.
    this.caPulse = Math.max(this.caPulse, (attack.name === 'kick' ? 0.6 : 0.35) * chargeMul);
    this.bloomPulse = Math.max(this.bloomPulse, (attack.name === 'kick' ? 0.7 : 0.4) * chargeMul);
    this.exposurePulse = Math.max(this.exposurePulse, (attack.name === 'kick' ? 0.15 : 0.08) * chargeMul);
    // One-beat radial streak toward the frame center — reads as the impact
    // shockwave. Scales with attack weight and stored charge.
    this.radialPulse = Math.max(this.radialPulse, (attack.name === 'kick' ? 0.55 : 0.32) * chargeMul);
  }

  // Decay the post-FX pulses and push them into the passes.
  _updateFx(dt) {
    this.caPulse *= Math.exp(-dt * 4);
    this.bloomPulse *= Math.exp(-dt * 5);
    this.exposurePulse *= Math.exp(-dt * 5);
    this.radialPulse *= Math.exp(-dt * 7);
    if (this.fxPass) {
      this.fxPass.uniforms.uCA.value = this.caPulse;
      this.fxPass.uniforms.uRadial.value = this.radialPulse;
      // KO color drain rides the lights-down blend (keeps the reds hot).
      this.fxPass.uniforms.uDesat.value = this.lightsDim * 0.55;
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

  // House-light choreography. Normally static; on KO the house dims over
  // ~0.5s, the overhead spotlight brightens and hunts the fallen fighter.
  // Backlights track their fighters every frame for rim separation.
  _updateLighting(dt) {
    const L = this.arena && this.arena.lights;
    if (!L) return;
    const target = this.cameraMode === 'ko' ? 1 : 0;
    this.lightsDim = THREE.MathUtils.lerp(this.lightsDim, target, Math.min(1, dt * 2.5));
    const d = this.lightsDim;
    L.hemi.intensity = 0.42 * (1 - d * 0.85);
    L.key.intensity = 1.6 * (1 - d * 0.75);
    L.rim.intensity = 0.7 * (1 - d * 0.5);
    L.fill.intensity = 0.35 * (1 - d * 0.85);
    L.cornerA.intensity = 1.3 * (1 - d * 0.9);
    L.cornerB.intensity = 1.3 * (1 - d * 0.9);
    L.spot.intensity = 1.1 + d * 1.6;
    // Studio rig panels dim with the house lights.
    if (L.rectA) L.rectA.intensity = 2.6 * (1 - d * 0.85);
    if (L.rectB) L.rectB.intensity = 1.8 * (1 - d * 0.85);
    // The volumetric shaft brightens as the hall goes dark — the classic
    // "single spotlight through smoky air" KO moment.
    const atmo = this.arena.atmo;
    if (atmo && atmo.cone) {
      atmo.cone.material.opacity = 0.09 + d * 0.14;
    }

    // Spotlight target: ring center normally, the loser during the KO.
    const loser = this.fighters && this.fighters.find((f) => f.state === 'ko');
    if (loser && d > 0.01) {
      const lp = loser.rig.root.position;
      _spotTarget.set(lp.x, 0, lp.z);
    } else {
      _spotTarget.set(0, 0, 0);
    }
    L.spot.target.position.lerp(_spotTarget, Math.min(1, dt * 3));

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
  }

  // Shared radial-gradient texture for the fighters' contact-shadow blobs.
  _makeBlobTexture() {
    if (this._blobTex) return this._blobTex;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,0.9)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.45)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this._blobTex = new THREE.CanvasTexture(c);
    return this._blobTex;
  }

  // Per-tick posture: head tracking toward the opponent, momentum lean from
  // the fighter's own velocity/acceleration, and the clinch-frame blend at
  // chest-to-chest range. All feed overlay targets on the animator.
  _updatePosture(f, opp, dt) {
    if (!opp || f.state === 'ko' || f.state === 'down') return;
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
  // (knockdown/KO) so the lying pose still reads as grounded.
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
      if (f.ragdoll && f.ragdoll.active) f.ragdoll.dispose();
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
      // Verlet ragdoll (knockdown path / legacy safety net).
      if (f.ragdoll && f.ragdoll.active) {
        f.ragdoll.step(dt);
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
          _koHead.z + 0.4);
        this.camera.position.lerp(target, k);
        this.camera.lookAt(_koHead.x, _koHead.y, _koHead.z);
        this.camera.fov = this.fovBase - 8 + Math.max(0, 4 - this.cameraModeT * 1.4);
      } else {
        // Cinematic KO shot: low, tight on the loser, slow push-in.
        const axis2 = p1.clone().sub(p2).normalize();
        const camSide = new THREE.Vector3(-axis2.z, 0, axis2.x);
        const target = lp.clone().add(camSide.multiplyScalar(3.0));
        target.y = 1.2;
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
      const sdt = Math.min(dt, 1 / 20);
      const K = 26, C = 8.5;
      this._camVel.x += ((target.x - this.camera.position.x) * K - this._camVel.x * C) * sdt;
      this._camVel.y += ((target.y - this.camera.position.y) * K - this._camVel.y * C) * sdt;
      this._camVel.z += ((target.z - this.camera.position.z) * K - this._camVel.z * C) * sdt;
      this.camera.position.addScaledVector(this._camVel, sdt);
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
      const joint = f.rig.joints[f.state === 'kick' ? 'footR' : 'fistR'];
      joint.getWorldPosition(_trailPos);
      t.points.push({ x: _trailPos.x, y: _trailPos.y, z: _trailPos.z });
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
      const w = 0.012 + 0.05 * a;     // ribbon half-width grows to the head
      const o = i * 6;
      pos[o] = p.x; pos[o + 1] = p.y - w; pos[o + 2] = p.z;
      pos[o + 3] = p.x; pos[o + 4] = p.y + w; pos[o + 5] = p.z;
      const br = a * a * 0.85;        // quadratic ramp — hot head, faint tail
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
        Math.round(this.fighters[0].energy * 100), Math.round(this.fighters[1].energy * 100))
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
    if (this.fighters) {
      for (const f of this.fighters) {
        if (f.swingPhysics) destroySwingPhysics(this._physics.world, f.swingPhysics);
        this._removeFighterPhysics(f);
        if (f.koRagdoll) f.koRagdoll.dispose();
      }
    }
    this._physics = null;
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
    if (this.fpsEl) this.fpsEl.remove();
    this.dotnet = null;
  }
}