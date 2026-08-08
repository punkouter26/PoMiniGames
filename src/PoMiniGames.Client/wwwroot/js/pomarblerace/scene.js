// scene.js — Three.js renderer/scene/lights + smooth orbit-follow camera, plus the full
// post-processing pipeline: ACES tone mapping, image-based lighting, dynamic shadows, bloom,
// vignette + chromatic aberration, SMAA, a graded background, a start FOV punch, and GPU sparks.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as PostFx from '../postFx.js';

const BG = 0x0f172a;            // cyberpunk dark slate
// Broadcast-style chase cam: higher and further back for a cleaner, more
// professional framing that shows the leader plus the track ahead.
// High, pulled-back overview: a positive default pitch orbits the camera UP and
// behind the leader so it looks down into the channel over the tall walls,
// showing a complete view of the pack and the track ahead.
// Raised and pulled back with the road: at CHANNEL_WIDTH 64 the old 26/46 vantage framed
// about a third of the chute's width, so marbles kept fighting off-screen.
// The camera now locks to the PLAYER'S marble (see _pickShot), which is a marble you steer —
// so the framing is a chase cam, not a pack overview: closer and a touch lower than the old
// broadcast vantage, tilted enough to read the road ahead so you can steer toward boost pads
// and away from the fall-off edge.
//
// CHASE, FLATTENED: the previous 52/38 vantage sat almost on top of the marble (≈58° down),
// so the frame was floor-plus-berms and the road ahead was a thin sliver at the top — the ramp
// was unreadable. Pulling BACK rather than UP flattens the look angle to ≈40° and lets the
// chute recede into frame, which is what makes the ramp legible.
// Constraint on CAM_HEIGHT: the berms rise TRACK.WALL_HEIGHT (44) above the road, so the eye
// must stay above ~50 or the near berm walls the shot in on turns. 46 + the pitch lift keeps
// it clear (see `vert` below) without going back to a top-down.
const CAM_HEIGHT = 46;          // base vantage height above the followed marble
const CAM_BACK = 62;            // behind the marble; the depth that lets the chute recede and read
const CAM_LOOKAHEAD = 20;       // aims down-track so the road ahead owns the frame, not the floor underfoot
const CAM_LOOK_LIFT = 6;        // lifts the aim point; the marble settles into the lower third, road above it
const CAM_DEFAULT_PITCH = 0.12;  // positive → camera rides above and looks down into the chute
const CAM_LERP = 3.4;          // slightly smoother follow reads more cinematic
// Shot changes used to teleport the camera (a === 1). With the demo camera on the leader of a
// 101-marble pack that fired several times a second, which is the "jumping". The director's-cut
// intent is kept — a change still resolves fast — but it now runs as a hard ease over
// CAM_CUT_TIME instead of a single-frame warp, so a cut reads as a whip-pan and a lead swap
// between two adjacent marbles reads as nothing at all. See also the shot hysteresis in
// game.js _pickShot, which stops most cuts from being requested in the first place.
const CAM_CUT_LERP = 11;        // follow rate while a cut is resolving (vs CAM_LERP when settled)
const CAM_CUT_TIME = 0.5;       // seconds a cut stays on the accelerated rate
const FOV_BASE = 60;
// #4 speed-reactive FOV: the frame widens as the followed marble speeds up, so velocity is felt
// and not just measured. Mapped from marble speed; the start-line FOV punch rides on top.
const FOV_SPEED_ADD = 10;       // max degrees added at top speed
const FOV_SPEED_LO = 25;        // speed at which the widening starts
const FOV_SPEED_HI = 90;        // speed at which it saturates

// Vignette + chromatic-aberration post pass (#10), now also carrying speed-reactive radial
// motion blur (GFX #2) and the state-driven colour grade (GFX #3). Runs in linear HDR before
// OutputPass.
//
// Both new effects live in THIS pass on purpose. A separate blur pass and a separate grading
// pass would each cost a full-screen render target and a full-screen resolve; folded in here
// they cost some extra taps and a handful of ALU on a pass that was already running. `uBlur`
// gates the taps and is a uniform, so when the marble is slow the branch is coherent across
// every invocation and the taps genuinely do not execute.
// Resting chromatic fringe. Named because updatePost now ADDS the impact
// envelope to it each frame and needs to know where "no impact" sits — reading
// the current uniform value back would integrate the punch into the baseline.
const ABERRATION_BASE = 0.0016;

const PostShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 1.15 },
    uAberration: { value: ABERRATION_BASE },
    uBlur: { value: 0.0 },              // #2 — radial smear strength, 0 = off
    uTint: { value: new THREE.Vector3(1, 1, 1) },   // #3 — grade
    uContrast: { value: 1.0 },
    uSaturation: { value: 1.0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uVignette; uniform float uAberration;
    uniform float uBlur; uniform vec3 uTint; uniform float uContrast; uniform float uSaturation;
    varying vec2 vUv;

    const int BLUR_TAPS = 6;

    // One chromatically-split sample. The R/B split is the pre-existing aberration; reusing it
    // inside the blur taps is what gives the smear its prismatic edge, so the "speed streaks"
    // cost nothing beyond the taps themselves.
    vec3 sampleSplit(vec2 uv, vec2 off) {
      return vec3(texture2D(tDiffuse, uv + off).r,
                  texture2D(tDiffuse, uv).g,
                  texture2D(tDiffuse, uv - off).b);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float d = dot(c, c);
      vec2 off = c * uAberration;

      vec3 col;
      if (uBlur > 0.001) {
        // Radial smear: successive taps march back toward frame centre, so the centre (where
        // the marble you steer sits) stays sharp and the edges streak. Weighted toward the
        // un-displaced tap so the image never goes soft, only fast.
        vec3 acc = vec3(0.0);
        float wsum = 0.0;
        for (int i = 0; i <= BLUR_TAPS; i++) {
          float t = float(i) / float(BLUR_TAPS);
          float s = 1.0 - t * uBlur * 0.09;
          float w = 1.0 - t * 0.55;
          acc += sampleSplit(0.5 + c * s, off) * w;
          wsum += w;
        }
        col = acc / wsum;
      } else {
        col = sampleSplit(vUv, off);
      }

      // Grade (#3): saturation, then contrast about mid-grey, then tint. Clamped at zero —
      // this runs in linear HDR, where a contrast push can otherwise drive channels negative
      // and OutputPass turns those into black speckle.
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;
      col = max(col * uTint, 0.0);

      float vig = smoothstep(0.95, 0.15, d * uVignette);
      gl_FragColor = vec4(col * mix(0.5, 1.0, vig), 1.0);
    }`,
};

// #3 grade presets. Eased toward, never snapped — see the grade easing in followTarget.
// `vignette` rides along so the frame closes in as the race gets tense.
const GRADES = {
  // Pre-race on the grid: cool, desaturated, flat. Clinical — nothing has happened yet.
  pick: { tint: [0.88, 0.94, 1.10], contrast: 0.94, saturation: 0.78, vignette: 1.30 },
  // The baseline look the game shipped with.
  racing: { tint: [1.00, 1.00, 1.00], contrast: 1.00, saturation: 1.00, vignette: 1.15 },
  // Final stretch: warm, contrasty, tighter vignette. Matches the HUD's own 0.86 threshold.
  final: { tint: [1.12, 1.02, 0.90], contrast: 1.12, saturation: 1.14, vignette: 1.55 },
  // Won: brief lift in saturation and exposure.
  win: { tint: [1.16, 1.10, 0.98], contrast: 1.08, saturation: 1.30, vignette: 1.05 },
  // Lost or eliminated: drain the colour out.
  loss: { tint: [0.92, 0.92, 0.96], contrast: 0.96, saturation: 0.35, vignette: 1.70 },
};

// Users who ask for reduced motion get the grade (a colour change, not motion) but never the
// radial blur. Matches the prefers-reduced-motion blocks already in PoMarbleRacePage.razor.css.
const REDUCED_MOTION = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
  : false;

// #2 blur mapping. Blur starts later than the FOV widening does — a mild speed should read as
// FOV alone, with the smear reserved for genuinely quick running so it stays meaningful.
const BLUR_SPEED_LO = 45;
const BLUR_SPEED_HI = 110;
const BLUR_MAX = 1.0;

function makeBgGradient() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#070b18');
  grd.addColorStop(0.55, '#0f172a');
  grd.addColorStop(1, '#16203c');
  g.fillStyle = grd; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(BG, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // #2 — filmic highlight rolloff
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;                     // #3 — dynamic shadows
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // FLICKER FIX (1/4) — anisotropy. Every procedural texture in track.js pinned itself to 4,
  // and the kerb stripes (hard red/white, seen at grazing angles by a chase cam) aliased into
  // crawling moiré at that level. Textures inherit this default, so raising it here raises it
  // for the whole track — createScene runs before generateTrack, and track.js's texture
  // singletons are built lazily on first use, so the ordering holds.
  THREE.Texture.DEFAULT_ANISOTROPY = renderer.capabilities.getMaxAnisotropy();
  container.style.position = 'relative';
  container.style.overflow = 'hidden';
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();
  const bgTexture = makeBgGradient();                     // #10 — graded background
  scene.background = bgTexture;
  // Fog pushed out with the camera: at 70/240 the far wall of a wide, sharply-turning chute
  // faded out before the turn it belongs to was readable. Pushed out again with CAM_BACK 38→62:
  // the marble alone now sits ~82 units from the eye, so at 110/340 the haze started biting a
  // few units past it and greyed out the exact stretch of ramp the pulled-back framing exists
  // to show.
  scene.fog = new THREE.Fog(BG, 170, 560);

  // #4 — image-based lighting so the glossy marbles/floor have something to reflect.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  pmrem.dispose();

  // FLICKER FIX (2/4) — depth precision. near 0.1 / far 2000 is a 20000:1 range, which leaves
  // almost no usable depth resolution out where the track is; the rumble/boost/kicker bands sit
  // a mere 0.05–0.06 above the floor ribbon and were z-fighting it, which is the flicker that
  // crawls across the road surface. Nothing is ever within 1 unit of this camera (it rides
  // ≥15 units off the marble at any orbit angle) and fog reaches BG by 560, so 1/1000 clips
  // nothing visible and buys ~20× the depth resolution.
  const camera = new THREE.PerspectiveCamera(FOV_BASE, 1, 1, 1000);
  camera.position.set(0, CAM_HEIGHT, -CAM_BACK);

  // Lighting — soft ambient + a shadow-casting key light; neon comes from emissive materials.
  scene.add(new THREE.AmbientLight(0x33405c, 0.9));
  scene.add(new THREE.HemisphereLight(0x5577ff, 0x0a0f1c, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(40, 80, -30);
  key.castShadow = true;
  // FLICKER FIX (3/4) — shadow crawl. The shadow camera is dragged along by the followed
  // marble every frame (see followTarget), so its texel grid slid continuously over the
  // geometry and every shadow edge boiled. 2048 over the 150-wide frustum halves the texel,
  // and followTarget quantises the light position to SHADOW_TEXEL so the grid steps instead
  // of sliding.
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 220;
  // Frustum widened to cover the 64-wide road — at ±42 the shadows were being clipped off
  // the outer thirds of the chute.
  key.shadow.camera.left = -75; key.shadow.camera.right = 75;
  key.shadow.camera.top = 75; key.shadow.camera.bottom = -75;
  key.shadow.bias = -0.0008;
  // frustum width ÷ map size — the world size of one shadow texel; followTarget snaps the
  // light to this grid so the map doesn't crawl as the camera follows.
  const SHADOW_TEXEL = 150 / 2048;
  scene.add(key);
  scene.add(key.target);

  // ── Post-processing composer ──────────────────────────────────────────
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.addPass(new RenderPass(scene, camera));

  // GTAO (§GFX-2). The chute is a big diffuse trough lit by one key light and an
  // environment map, so before this the marbles read as *hovering over* the road
  // rather than rolling on it — there was no contact darkening anywhere. Ground
  // truth ambient occlusion is what puts them back in contact with the floor.
  //
  // High tier only, and OFF rather than degraded below it: GTAO costs a depth +
  // normal prepass, which is the wrong thing to be paying for on a machine that
  // is already dropping frames. The scene still reads correctly without it.
  let gtao = null;
  if (PostFx.allowHeavy()) {
    gtao = new GTAOPass(scene, camera, 1, 1);
    gtao.output = GTAOPass.OUTPUT.Default;
    // Radius in world units. The track is ~64 wide and marbles are radius 1, so
    // a small radius is right — a large one would darken whole berms instead of
    // the crease where a marble meets the road.
    gtao.updateGtaoMaterial({ radius: 2.2, distanceExponent: 1.0, thickness: 1.0, scale: 1.1 });
    composer.addPass(gtao);
  }

  // Bloom strength dropped (0.75 → 0.18) and threshold raised (0.82 → 0.92) so the
  // pass adds only a faint highlight to the brightest specular spots instead of
  // glowing every emissive marble into a halo.
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.6, 0.92); // strength, radius, threshold
  composer.addPass(bloom);                                // #1 — bloom

  // Rack focus (§GFX-2). Disabled during the race; the photo finish turns it on
  // for a beat. See postFx.js for why a transient DoF pass is affordable and a
  // permanent one is not.
  const rackFocus = PostFx.createRackFocus(scene, camera, 1, 1);
  composer.addPass(rackFocus.pass);
  // ShaderPass CLONES the uniforms off the descriptor, so drive `post.uniforms` — writing to
  // PostShader.uniforms would touch the module-level template and leak between scenes.
  const post = new ShaderPass(PostShader);                // #10 vignette/aberration + #2 blur + #3 grade
  composer.addPass(post);
  const smaa = new SMAAPass(1, 1);                        // #10 — anti-aliasing for the bloom pipeline
  composer.addPass(smaa);
  composer.addPass(new OutputPass());                     // tone-map + sRGB to screen

  // ── GPU spark pool (#7 — collision sparks) ────────────────────────────
  const SPARKS = 160;
  const sparkPos = new Float32Array(SPARKS * 3);
  const sparkCol = new Float32Array(SPARKS * 3);
  const sparkVel = new Float32Array(SPARKS * 3);
  const sparkLife = new Float32Array(SPARKS);
  const sparkBase = new Float32Array(SPARKS * 3);
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3));
  const sparkMat = new THREE.PointsMaterial({
    size: 0.7, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
  sparkPoints.frustumCulled = false;
  for (let i = 0; i < SPARKS; i++) { sparkPos[i * 3 + 1] = -9999; }
  scene.add(sparkPoints);
  let sparkHead = 0;
  const _col = new THREE.Color();

  function burstSparks(pos, colorHex, count = 9, strength = 1) {
    _col.set(colorHex ?? 0xffd9a0);
    for (let k = 0; k < count; k++) {
      const i = sparkHead; sparkHead = (sparkHead + 1) % SPARKS;
      sparkPos[i * 3] = pos.x; sparkPos[i * 3 + 1] = pos.y; sparkPos[i * 3 + 2] = pos.z;
      sparkVel[i * 3] = (Math.random() - 0.5) * 10 * strength;
      sparkVel[i * 3 + 1] = (Math.random() * 0.7 + 0.3) * 9 * strength;
      sparkVel[i * 3 + 2] = (Math.random() - 0.5) * 10 * strength;
      sparkLife[i] = 1;
      sparkBase[i * 3] = _col.r; sparkBase[i * 3 + 1] = _col.g; sparkBase[i * 3 + 2] = _col.b;
    }
  }

  // Multicolored confetti burst — reuses the spark pool but with random bright
  // colors and a strong upward pop. Fired when a marble crosses the finish line.
  const CONFETTI_COLORS = [0x22d3ee, 0xe879f9, 0xa3e635, 0xfb923c, 0xf87171, 0x60a5fa, 0xfde047, 0xf472b6, 0xffffff];
  function burstConfetti(pos, count = 24) {
    for (let k = 0; k < count; k++) {
      const i = sparkHead; sparkHead = (sparkHead + 1) % SPARKS;
      sparkPos[i * 3] = pos.x; sparkPos[i * 3 + 1] = pos.y + 1.2; sparkPos[i * 3 + 2] = pos.z;
      sparkVel[i * 3] = (Math.random() - 0.5) * 16;
      sparkVel[i * 3 + 1] = Math.random() * 12 + 7;
      sparkVel[i * 3 + 2] = (Math.random() - 0.5) * 16;
      sparkLife[i] = 1.3;
      _col.set(CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0]);
      sparkBase[i * 3] = _col.r; sparkBase[i * 3 + 1] = _col.g; sparkBase[i * 3 + 2] = _col.b;
    }
  }

  function updateSparks(dt) {
    let any = false;
    for (let i = 0; i < SPARKS; i++) {
      if (sparkLife[i] <= 0) continue;
      any = true;
      sparkLife[i] -= dt / 0.45;
      const l = Math.max(0, sparkLife[i]);
      sparkVel[i * 3 + 1] -= 26 * dt;
      sparkPos[i * 3] += sparkVel[i * 3] * dt;
      sparkPos[i * 3 + 1] += sparkVel[i * 3 + 1] * dt;
      sparkPos[i * 3 + 2] += sparkVel[i * 3 + 2] * dt;
      sparkCol[i * 3] = sparkBase[i * 3] * l;
      sparkCol[i * 3 + 1] = sparkBase[i * 3 + 1] * l;
      sparkCol[i * 3 + 2] = sparkBase[i * 3 + 2] * l;
      if (sparkLife[i] <= 0) { sparkPos[i * 3 + 1] = -9999; sparkCol[i * 3] = sparkCol[i * 3 + 1] = sparkCol[i * 3 + 2] = 0; }
    }
    if (any) { sparkGeo.attributes.position.needsUpdate = true; sparkGeo.attributes.color.needsUpdate = true; }
  }

  // ── Shockwave rings (#4) ──────────────────────────────────────────────
  // A fixed pool of flat rings that expand and fade on a heavy impact. Additive and unlit with
  // depthWrite off, so they cost no lighting, cast no shadow, and never z-fight the road they
  // sit above. Same fire/age/recycle shape as the spark pool above — pre-allocated once, so a
  // 30-marble pile-up allocates nothing.
  const RINGS = 8;
  const RING_LIFE = 0.42;       // seconds from fire to fully faded
  const RING_R0 = 0.9;          // starting radius (about a marble)
  const RING_R1 = 13;           // radius at end of life
  const ringGeo = new THREE.RingGeometry(1, 1.14, 32);
  const ringPool = [];
  let ringHead = 0;
  for (let i = 0; i < RINGS; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;   // lie flat on the road
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    scene.add(mesh);
    ringPool.push({ mesh, mat, life: 0 });
  }

  // Fire one ring at a world position. Recycles the oldest slot when the pool is exhausted,
  // which is the correct behaviour here: in a pile-up the newest impacts are the ones worth
  // seeing.
  function burstRing(pos, colorHex, scale = 1) {
    const r = ringPool[ringHead];
    ringHead = (ringHead + 1) % RINGS;
    r.life = RING_LIFE;
    r.scale = scale;
    r.mat.color.set(colorHex ?? 0xffd9a0);
    r.mesh.position.set(pos.x, pos.y + 0.35, pos.z);
    r.mesh.visible = true;
  }

  function updateRings(dt) {
    for (const r of ringPool) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.mesh.visible = false; r.mat.opacity = 0; continue; }
      const t = 1 - r.life / RING_LIFE;               // 0 at fire → 1 at death
      const rad = (RING_R0 + (RING_R1 - RING_R0) * t) * (r.scale || 1);
      r.mesh.scale.set(rad, rad, rad);
      // Fade out on a curve rather than linearly, so the ring reads as a snap rather than a
      // slow bloom.
      r.mat.opacity = (1 - t) * (1 - t) * 0.85;
    }
  }

  // ── Audio spatialization helper (#9) ──────────────────────────────────
  // Turns a world position into a stereo pan and a distance gain relative to the LIVE camera,
  // so audio.js never needs to know about the camera or three.js at all. Pan comes from the
  // projected NDC x, which is exactly "where on screen did this happen" — the thing a player
  // is actually looking at when the sound arrives.
  const _cue = new THREE.Vector3();
  const AUDIO_NEAR = 30;        // full volume within this distance
  const AUDIO_FAR = 420;        // floor volume at/after this distance
  const AUDIO_FLOOR = 0.18;     // distant events recede but never vanish
  function audioCue(pos) {
    _cue.set(pos.x, pos.y, pos.z);
    const dist = _cue.distanceTo(camera.position);
    _cue.project(camera);
    // NDC x is unbounded behind the camera; clamp so an off-screen event pans hard rather than
    // producing a nonsense pan value.
    const pan = Math.max(-1, Math.min(1, _cue.x));
    const t = Math.max(0, Math.min(1, (dist - AUDIO_NEAR) / (AUDIO_FAR - AUDIO_NEAR)));
    return { pan, gain: 1 - (1 - AUDIO_FLOOR) * t };
  }

  const camTarget = new THREE.Vector3();
  let haveTarget = false;
  let cutT = 0;                 // seconds left on the accelerated post-cut ease
  let fovPunch = 0;
  function punchFov() { fovPunch = -9; }

  // ── #2 blur + #3 grade state ──────────────────────────────────────────
  // Live values are eased toward the targets every frame so a grade change is always a
  // transition and never a cut. `blurPunch` is a decaying transient laid over the speed-driven
  // blur, fired at the start gun and on boost-pad entry.
  let blurPunch = 0;
  let gradeTo = GRADES.racing;
  const gradeNow = {
    tint: new THREE.Vector3(1, 1, 1), contrast: 1, saturation: 1, vignette: 1.15,
  };

  // Name one of GRADES ('pick' | 'racing' | 'final' | 'win' | 'loss'). Unknown names are
  // ignored rather than throwing — the grade is decoration, and a typo here must never take
  // the render loop down mid-race.
  function setGrade(name) {
    const g = GRADES[name];
    if (g) gradeTo = g;
  }

  function punchBlur(amount = 0.55) {
    if (REDUCED_MOTION) return;
    blurPunch = Math.max(blurPunch, amount);
  }

  function updatePost(dt, speed) {
    const k = 1 - Math.exp(-3.2 * dt);      // grade easing; slower than the FOV so it reads as a mood shift
    gradeNow.tint.x += (gradeTo.tint[0] - gradeNow.tint.x) * k;
    gradeNow.tint.y += (gradeTo.tint[1] - gradeNow.tint.y) * k;
    gradeNow.tint.z += (gradeTo.tint[2] - gradeNow.tint.z) * k;
    gradeNow.contrast += (gradeTo.contrast - gradeNow.contrast) * k;
    gradeNow.saturation += (gradeTo.saturation - gradeNow.saturation) * k;
    gradeNow.vignette += (gradeTo.vignette - gradeNow.vignette) * k;

    const u = post.uniforms;
    u.uTint.value.copy(gradeNow.tint);
    u.uContrast.value = gradeNow.contrast;
    u.uSaturation.value = gradeNow.saturation;
    u.uVignette.value = gradeNow.vignette;

    // §GFX-2/8 — the shared impact envelope rides on top of the baseline fringe.
    // Adding rather than assigning keeps the permanent slight aberration the
    // look depends on; a collision now widens it for as long as impactBus says
    // the hit is still ringing, so the 3D image and the DOM chrome react to the
    // same event on the same curve.
    u.uAberration.value = ABERRATION_BASE + PostFx.punchAberration();

    // Radial motion blur: REMOVED 2026-08-07 (user request).
    //
    // This ramped a radial smear in with speed (from BLUR_SPEED_LO up to
    // BLUR_MAX), plus a decaying punch fired at the start gun and on every
    // boost pad. Because the player's marble spends most of a race above the
    // ramp's lower bound, the smear was effectively on for the whole run —
    // it did not read as "fast", it read as an out-of-focus picture.
    //
    // Pinned to 0, which is also the value the shader branches on to skip the
    // blur taps entirely, so this is a straight saving. `blurPunch` is still
    // decayed below so the boost/start-gun callers that raise it stay harmless
    // no-ops rather than accumulating forever.
    u.uBlur.value = 0;
    blurPunch = blurPunch > 0.005 ? blurPunch * Math.exp(-3.5 * dt) : 0;
  }

  // ── Left-drag mouse orbit around the followed target ──────────────────
  let orbitYaw = 0;
  let orbitPitch = CAM_DEFAULT_PITCH; // start tilted down so the marble sits centered, not at the top
  let dragging = false;
  let lastX = 0, lastY = 0;
  const YAW_SPEED = 0.008, PITCH_SPEED = 0.006;
  const PITCH_MIN = -0.55, PITCH_MAX = 1.15;

  const canvas = renderer.domElement;
  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'none';

  const onPointerDown = (e) => {
    if (e.button !== 0) return;           // left button only
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
    try { canvas.setPointerCapture(e.pointerId); } catch { }
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    orbitYaw -= dx * YAW_SPEED;
    orbitPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, orbitPitch + dy * PITCH_SPEED));
  };
  const onPointerUp = () => {
    dragging = false;
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  function resize() {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 540;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    composer.setSize(w, h);
    bloom.setSize(w, h);
    smaa.setSize(w, h);
    // Both of these own internal render targets sized independently of the
    // composer's; missing either leaves it sampling a stale buffer at the old
    // aspect, which shows up as the AO or the bokeh being stretched.
    if (gtao) gtao.setSize(w, h);
    rackFocus.setSize(w, h);
  }
  resize();
  window.addEventListener('resize', resize);

  // Smoothly move the camera to orbit-and-follow `pos`. With no drag this is the default
  // above-and-behind view; left-drag adds a yaw/pitch offset that rotates around the target.
  // `forward` (optional) is the track's full 3D heading at the followed marble. It places the
  // camera (behind along the track rather than behind in world -Z, and lifted by the climb of
  // the ground behind) as well as aiming it down-track along travel, so the road ahead reads
  // around curves and down the ramp. `speed` (optional) drives the speed-reactive FOV.
  function followTarget(pos, dt, snap, forward, speed) {
    // Track-relative framing. The offset used to be a fixed world -Z, which is wrong twice over
    // on this track: the chute TURNS (so "behind in -Z" can put the camera in FRONT of the
    // marble through a hairpin), and it DESCENDS at up to ~0.42 (so a fixed world-Y lift leaves
    // the eye below the 44-unit berms of the stretch behind, which then wall the shot in — the
    // pulled-back CAM_BACK made that unmissable). Offsetting along the track's own heading and
    // adding the climb of the ground behind keeps the eye CAM_HEIGHT above the *track surface*
    // it has to see over, on the flat and on the ramp alike.
    let fx = 0, fy = 0, fz = 1;                  // unit heading of travel; +Z when not supplied
    if (forward) {
      const L = Math.hypot(forward.x, forward.y, forward.z) || 1;
      fx = forward.x / L; fy = forward.y / L; fz = forward.z / L;
    }
    const fxz = Math.hypot(fx, fz) || 1;
    const horiz = CAM_BACK * Math.cos(orbitPitch);
    const vert = CAM_HEIGHT + CAM_BACK * Math.sin(orbitPitch);
    const climb = -(fy / fxz) * horiz;           // fy < 0 descending → the ground behind is higher
    // Backward heading rotated by the orbit yaw; yaw 0 → directly behind, matching the old
    // (sin, -cos) world offset when `forward` is +Z.
    const bx = -fx / fxz, bz = -fz / fxz;
    const cy = Math.cos(orbitYaw), sy = Math.sin(orbitYaw);
    const desired = new THREE.Vector3(
      pos.x + (bx * cy - bz * sy) * horiz,
      pos.y + vert + climb,
      pos.z + (bx * sy + bz * cy) * horiz);
    // `snap` no longer teleports. It arms CAM_CUT_TIME of accelerated easing, so a director's
    // cut still resolves in a few frames but travels rather than warping. The one true warp
    // left is placement: the first call, and the dt === 0 calls _buildTrack makes to frame the
    // start gate, where easing would move the camera nowhere at all.
    if (snap) cutT = CAM_CUT_TIME;
    const instant = !haveTarget || dt <= 0;
    const a = instant ? 1 : 1 - Math.exp(-(cutT > 0 ? CAM_CUT_LERP : CAM_LERP) * dt);
    cutT = Math.max(0, cutT - dt);
    camera.position.lerp(desired, a);

    // Look-ahead along the direction of travel (falls back to straight down-track). Only when
    // roughly behind the target, so it stays centred when orbited round. Lift the look-at point
    // so the marble (radius ≈ 1) sits ~mid-screen instead of clipped against the bottom edge.
    // The aim point rides the full 3D heading, so on the ramp it tracks the road DOWN instead of
    // floating above it — aiming a flat CAM_LOOKAHEAD ahead in XZ only pointed the camera at
    // empty air over a descent, which is half of why the ramp never read.
    const laFactor = Math.max(0, Math.cos(orbitYaw)) * CAM_LOOKAHEAD;
    const look = new THREE.Vector3(
      pos.x + fx * laFactor,
      pos.y + fy * laFactor + CAM_LOOK_LIFT,
      pos.z + fz * laFactor);
    if (!haveTarget) { camTarget.copy(look); haveTarget = true; }
    camTarget.lerp(look, a);
    camera.lookAt(camTarget);

    // Keep the shadow-casting key light (and its frustum) over the action for crisp shadows.
    // Quantised to the shadow texel grid (see SHADOW_TEXEL): following the marble's exact
    // position slid the shadow map by a fraction of a texel every frame, which boils every
    // shadow edge in the scene. Stepping in whole texels keeps the map stationary between
    // steps, so edges stay put.
    const qx = Math.round(pos.x / SHADOW_TEXEL) * SHADOW_TEXEL;
    const qy = Math.round(pos.y / SHADOW_TEXEL) * SHADOW_TEXEL;
    const qz = Math.round(pos.z / SHADOW_TEXEL) * SHADOW_TEXEL;
    key.position.set(qx + 28, qy + 70, qz - 18);
    key.target.position.set(qx, qy, qz + 6);
    key.target.updateMatrixWorld();

    // FOV: base + speed-reactive widening (#4) + start-line punch (#10), all eased toward.
    const spd = speed || 0;
    const speedT = Math.max(0, Math.min(1, (spd - FOV_SPEED_LO) / (FOV_SPEED_HI - FOV_SPEED_LO)));
    const targetFov = FOV_BASE + speedT * FOV_SPEED_ADD + fovPunch;
    camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-5 * dt));
    camera.updateProjectionMatrix();
    fovPunch = Math.abs(fovPunch) > 0.05 ? fovPunch * Math.exp(-6 * dt) : 0;

    // §GFX-8 — camera shake, applied LAST so it offsets the final framing. Put
    // before lookAt it would be cancelled out, because lookAt recomputes the
    // orientation from the (already shaken) position and the shake would only
    // translate the eye without moving the image.
    PostFx.applyCameraShake(camera, performance.now() / 1000, 1.4);

    updateSparks(dt);
    updateRings(dt);            // #4 — expanding shockwave rings
    updatePost(dt, spd);        // #2 blur + #3 grade, driven by the same speed the FOV uses
    rackFocus.update(dt);       // §GFX-2 — no-op unless a photo finish is running
  }

  return {
    scene,
    camera,
    renderer,
    add(obj) { scene.add(obj); },
    remove(obj) { scene.remove(obj); },
    followTarget,
    burstSparks,
    burstConfetti,
    burstRing,        // #4
    audioCue,         // #9
    setGrade,         // #3
    punchBlur,        // #2
    punchFov,
    /**
     * §GFX-2 — rack the focus for the photo finish. `distance` is how far the
     * winning marble is from the camera; the chase cam holds it at roughly
     * CAM_BACK, so that is the default and callers only need to pass a value if
     * they are framing something else.
     */
    photoFinish(distance) {
      rackFocus.trigger(distance == null ? CAM_BACK : distance, 1.1, 1);
    },
    render() { composer.render(); },
    resize,
    dispose() {
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      sparkGeo.dispose();
      sparkMat.dispose();
      // Rings share one geometry across the pool; each owns its own material (they carry
      // independent colour + opacity), so the geometry is disposed once and the materials each.
      ringGeo.dispose();
      for (const r of ringPool) r.mat.dispose();
      bgTexture.dispose();
      envRT.texture.dispose();
      rackFocus.dispose();
      gtao?.dispose?.();
      composer.dispose();
      renderer.dispose();
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    },
  };
}
