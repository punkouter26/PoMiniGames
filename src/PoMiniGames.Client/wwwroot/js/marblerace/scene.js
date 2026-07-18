// scene.js — Three.js renderer/scene/lights + smooth orbit-follow camera, plus the full
// post-processing pipeline: ACES tone mapping, image-based lighting, dynamic shadows, bloom,
// vignette + chromatic aberration, SMAA, a graded background, a start FOV punch, and GPU sparks.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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
const CAM_HEIGHT = 30;          // base vantage height above the followed marble
const CAM_BACK = 54;            // behind the marble; close enough to feel the speed, back enough to see ahead
const CAM_LOOKAHEAD = 28;       // look well down-track (along travel) so turns/hazards are anticipated
const CAM_LOOK_LIFT = 2;        // look-at just above the marble
const CAM_DEFAULT_PITCH = 0.22;  // positive → camera rides above and looks down into the chute
const CAM_LERP = 3.4;          // slightly smoother follow reads more cinematic
const FOV_BASE = 60;
// #4 speed-reactive FOV: the frame widens as the followed marble speeds up, so velocity is felt
// and not just measured. Mapped from marble speed; the start-line FOV punch rides on top.
const FOV_SPEED_ADD = 10;       // max degrees added at top speed
const FOV_SPEED_LO = 25;        // speed at which the widening starts
const FOV_SPEED_HI = 90;        // speed at which it saturates

// Vignette + chromatic-aberration post pass (#10). Runs in linear HDR before OutputPass.
const PostShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 1.15 },
    uAberration: { value: 0.0016 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uVignette; uniform float uAberration; varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float d = dot(c, c);
      vec2 off = c * uAberration;
      float r = texture2D(tDiffuse, vUv + off).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - off).b;
      float vig = smoothstep(0.95, 0.15, d * uVignette);
      gl_FragColor = vec4(vec3(r, g, b) * mix(0.5, 1.0, vig), 1.0);
    }`,
};

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
  container.style.position = 'relative';
  container.style.overflow = 'hidden';
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();
  const bgTexture = makeBgGradient();                     // #10 — graded background
  scene.background = bgTexture;
  // Fog pushed out with the camera: at 70/240 the far wall of a wide, sharply-turning chute
  // faded out before the turn it belongs to was readable.
  scene.fog = new THREE.Fog(BG, 110, 340);

  // #4 — image-based lighting so the glossy marbles/floor have something to reflect.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(FOV_BASE, 1, 0.1, 2000);
  camera.position.set(0, CAM_HEIGHT, -CAM_BACK);

  // Lighting — soft ambient + a shadow-casting key light; neon comes from emissive materials.
  scene.add(new THREE.AmbientLight(0x33405c, 0.9));
  scene.add(new THREE.HemisphereLight(0x5577ff, 0x0a0f1c, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(40, 80, -30);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 220;
  // Frustum widened to cover the 64-wide road — at ±42 the shadows were being clipped off
  // the outer thirds of the chute.
  key.shadow.camera.left = -75; key.shadow.camera.right = 75;
  key.shadow.camera.top = 75; key.shadow.camera.bottom = -75;
  key.shadow.bias = -0.0008;
  scene.add(key);
  scene.add(key.target);

  // ── Post-processing composer ──────────────────────────────────────────
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.addPass(new RenderPass(scene, camera));
  // Bloom strength dropped (0.75 → 0.18) and threshold raised (0.82 → 0.92) so the
  // pass adds only a faint highlight to the brightest specular spots instead of
  // glowing every emissive marble into a halo.
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.6, 0.92); // strength, radius, threshold
  composer.addPass(bloom);                                // #1 — bloom
  composer.addPass(new ShaderPass(PostShader));           // #10 — vignette + chromatic aberration
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

  const camTarget = new THREE.Vector3();
  let haveTarget = false;
  let fovPunch = 0;
  function punchFov() { fovPunch = -9; }

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
  }
  resize();
  window.addEventListener('resize', resize);

  // Smoothly move the camera to orbit-and-follow `pos`. With no drag this is the default
  // above-and-behind view; left-drag adds a yaw/pitch offset that rotates around the target.
  // `forward` (optional) is the followed marble's horizontal heading, used to look down-track
  // *along travel* so the road ahead is visible around curves; `speed` (optional) drives the
  // speed-reactive FOV.
  function followTarget(pos, dt, snap, forward, speed) {
    const horiz = CAM_BACK * Math.cos(orbitPitch);
    const vert = CAM_HEIGHT + CAM_BACK * Math.sin(orbitPitch);
    const offX = horiz * Math.sin(orbitYaw);
    const offZ = -horiz * Math.cos(orbitYaw);   // yaw 0 → straight behind (-Z)
    const desired = new THREE.Vector3(pos.x + offX, pos.y + vert, pos.z + offZ);
    const a = snap ? 1 : 1 - Math.exp(-CAM_LERP * dt);
    camera.position.lerp(desired, a);

    // Look-ahead along the direction of travel (falls back to straight down-track). Only when
    // roughly behind the target, so it stays centred when orbited round. Lift the look-at point
    // so the marble (radius ≈ 1) sits ~mid-screen instead of clipped against the bottom edge.
    let laX = 0, laZ = 1;
    if (forward) {
      const fl = Math.hypot(forward.x, forward.z) || 1;
      laX = forward.x / fl; laZ = forward.z / fl;
    }
    const laFactor = Math.max(0, Math.cos(orbitYaw)) * CAM_LOOKAHEAD;
    const look = new THREE.Vector3(
      pos.x + laX * laFactor,
      pos.y + CAM_LOOK_LIFT,
      pos.z + laZ * laFactor);
    if (!haveTarget) { camTarget.copy(look); haveTarget = true; }
    camTarget.lerp(look, a);
    camera.lookAt(camTarget);

    // Keep the shadow-casting key light (and its frustum) over the action for crisp shadows.
    key.position.set(pos.x + 28, pos.y + 70, pos.z - 18);
    key.target.position.set(pos.x, pos.y, pos.z + 6);
    key.target.updateMatrixWorld();

    // FOV: base + speed-reactive widening (#4) + start-line punch (#10), all eased toward.
    const spd = speed || 0;
    const speedT = Math.max(0, Math.min(1, (spd - FOV_SPEED_LO) / (FOV_SPEED_HI - FOV_SPEED_LO)));
    const targetFov = FOV_BASE + speedT * FOV_SPEED_ADD + fovPunch;
    camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-5 * dt));
    camera.updateProjectionMatrix();
    fovPunch = Math.abs(fovPunch) > 0.05 ? fovPunch * Math.exp(-6 * dt) : 0;

    updateSparks(dt);
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
    punchFov,
    render() { composer.render(); },
    resize,
    dispose() {
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      sparkGeo.dispose();
      sparkMat.dispose();
      bgTexture.dispose();
      envRT.texture.dispose();
      composer.dispose();
      renderer.dispose();
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    },
  };
}
