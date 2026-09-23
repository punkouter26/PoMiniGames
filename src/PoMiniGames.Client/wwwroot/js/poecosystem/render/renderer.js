// renderer.js — the three.js side: owns the scene, the camera the player controller
// drives, the frame interpolation, and the render loop.
//
// Frames arrive at 20 Hz and are drawn at display rate, so two frames are kept and
// positions/yaws are interpolated between them; every frame buffer is returned to the sim
// worker as soon as its data has been copied out, which is what keeps the pool from
// running dry (see host/simRuntime.js).
//
// It is also the conductor for the GFX stack added alongside it: the composer
// (postProcess.js), the particle field (particles.js), the event router (eventFx.js) and
// the atmosphere (lighting.js) all hang off this one frame loop, because every one of them
// needs the same three facts — the frame delta, where the camera is, and what time of day
// the sim thinks it is.
import * as THREE from 'three';
import { CREATURE_CAP, PROP_CAP } from '../sim/core/config.js';
import { FRAME, frameViews } from '../sim/frame.js';
import { TILE_STATE } from '../sim/terrain/tiles.js';
import { createTerrainMesh } from './terrainMesh.js';
import { createLighting } from './lighting.js';
import { createCreatureMeshes } from './creatureMeshes.js';
import { createPropMeshes } from './propMeshes.js';
import { createFloraMeshes } from './floraMeshes.js';
import { createMinimap } from './minimap.js';
import { blockedTiles, createPlayer, stepPlayer } from './playerController.js';
import { createInput } from './input.js';
import { pickCreature } from './picking.js';
import { createPostProcess } from './postProcess.js';
import { createParticles } from './particles.js';
import { createEventFx } from './eventFx.js';
import { createDirector } from './director.js';
import { createPip } from './pip.js';
import { createSky } from './sky.js';
import { materialClock, materialDetail, materialSeason, materialSnow } from './materials.js';
import { applyCameraShake } from '../../postFx.js';
import { createSettlementMeshes } from './settlementMesh.js';
import { createFauna } from './fauna.js';

const TAU = Math.PI * 2;
// What the auto-director calls a cut to an event tile.
const EVENT_CAPTIONS = { lightning: 'Lightning strike', rockslide: 'Rockslide', eruption: 'The volcano erupts', tech: 'The tribe builds', outbreak: 'Sickness spreads' };
// Weather kinds (sim/events/weather.js) → how closed the cloud deck is.
const OVERCAST = [0, 0.7, 1, 0, 0.6];
const WEATHER_STORM = 2;
const shortestAngle = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Adaptive resolution. The floor is deliberately high: below ~0.6x the island reads as
// mush, and a game that has gone soft is worse than one that has gone to 40 fps.
const DPR_FLOOR = 0.62;
const DPR_DOWN_FPS = 45;
const DPR_UP_FPS = 58;
const DPR_DOWN_SECONDS = 2;    // consecutive bad seconds before dropping — one stutter is not a trend
const DPR_UP_SECONDS = 6;      // and a long run of good ones before climbing back

export function createRenderer(container, {
  cap = CREATURE_CAP, propCap = PROP_CAP, minimapCanvas = null, quality = {}, audio = null,
  onPick = () => {}, onAction = () => {}, onFps = () => {},
  // The auto-director takes the camera after this many seconds without input (0 = never);
  // demo mode passes a few seconds, 1-player a couple of minutes.
  directorIdleSeconds = 0,
  // Accessibility (Settings): 'default' | 'cb' tribe banner colours, and no camera shake.
  palette = 'default', reducedMotion = false,
  // Key bindings (input.js DEFAULT_BINDINGS shape), loaded from prefs by the engine.
  bindings = null,
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'poeco-canvas';
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:crosshair;';
  container.appendChild(canvas);

  // PoQuality is the app's quality authority (?fx= override, reduced-motion cap, battery
  // demotion, fps watchdog); the core count is only the fallback when it has not loaded.
  // An explicit tier from the Settings panel wins outright (it is the player's choice, made
  // on this machine); otherwise the old resolution applies.
  const forcedTier = quality.tier === 'high' || quality.tier === 'medium' || quality.tier === 'low' ? quality.tier : null;
  const lowEnd = forcedTier ? forcedTier === 'low' : (quality.lowEnd ?? (window.PoQuality ? window.PoQuality.tier() === 'low' : (navigator.hardwareConcurrency ?? 8) <= 4));
  // One tier string, resolved once, handed to every subsystem. `lowEnd` from the caller is
  // an override that can only demote — a Blazor-side low-end hint must not be undone by a
  // machine that happens to report a fast GPU.
  const tier = forcedTier ?? (lowEnd ? 'low' : (window.PoQuality?.tier?.() ?? 'high'));
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowEnd, powerPreference: 'high-performance' });
  const maxDpr = window.PoCanvasDpr?.ceiling ? window.PoCanvasDpr.ceiling(lowEnd ? 1 : 2) : Math.min(devicePixelRatio || 1, lowEnd ? 1 : 2);
  let dprScale = 1;
  renderer.setPixelRatio(maxDpr);
  renderer.shadowMap.enabled = !lowEnd;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.5, 700);
  // lighting owns scene.fog now: its colour and density both ride the same day/night curve
  // as the sky, and the water and particle shaders read the density back off it.
  const lighting = createLighting(scene, { shadows: !lowEnd, shadowMapSize: lowEnd ? 1024 : 2048, tier });
  // The sky dome and clouds ride the camera; every hooked Lambert material (materials.js)
  // reads one shared clock, set once per frame below.
  const skyDome = createSky(scene, { tier });
  materialDetail.value = tier === 'low' ? 0 : 1;
  const creatures = createCreatureMeshes(scene, cap);
  const props = createPropMeshes(scene, propCap);
  const particles = createParticles(scene, { tier });
  const eventFx = createEventFx(particles, audio, { tier });
  const post = createPostProcess(renderer, scene, camera, {
    tier, width: container.clientWidth || 1, height: container.clientHeight || 1, pixelRatio: maxDpr,
  });

  // terrainApi mirrors the sim terrain's read API (heightAt/type) from the transferred arrays.
  let terrainApi = null;       // heightAt/type lookups the controller needs
  let island = null;
  let flora = null;
  let minimap = null;
  let player = createPlayer({ size: 200, heightAt: () => 0, type: new Uint8Array(200 * 200) }, 'fly');
  let pendingPose = null;      // a pose set before the first terrain message
  let terrainReady = false;
  let settlementMeshes = null;
  let fauna = null;
  // Weather as the last stats message reported it; the per-frame emitters read it.
  let weatherKind = 0; let weatherIntensity = 0;
  let rainDebt = 0;
  // The tour (Blazor) wants to know the first look and the first step, once each.
  const told = { look: false, move: false };
  // The page can hold the director off (the onboarding tour needs the camera to stay put).
  let directorHeld = false;
  let lastRecycle = null;
  let contextLost = false;
  let motionReduced = !!reducedMotion;

  // Two frames + their views, for interpolation.
  let prev = null; let curr = null; let prevAt = 0; let currAt = 0;
  const interp = new Float32Array(cap * FRAME.CREATURE_STRIDE);
  const speeds = new Float32Array(cap);
  let interpCount = 0;
  let propCount = 0;
  let hovered = null;
  let followHandle = -1;
  let stats = null;
  let running = true;
  let fps = 0; let frames = 0; let fpsAt = 0;
  let slowSeconds = 0; let fastSeconds = 0;
  let lastTime = 0;
  let lastPropTick = -1;   // the impact watcher runs per SIM frame, not per rendered frame

  // Burning and molten tile positions, rebuilt on each tile sync (1 Hz) so the per-frame
  // plume emitter never has to walk the 40 000-entry tile array.
  let fireTiles = [];
  let lavaTiles = [];

  const sunNdc = new THREE.Vector3();
  const sunView = new THREE.Vector3();
  const sunUv = new THREE.Vector2();
  const sunFromCam = new THREE.Vector3();

  // The campfire's light (behavior/tech.js FIRE): one point light parked on the hearth,
  // bright at night and a flicker by day. Zero intensity until the tribe has a fire.
  const campfireLight = new THREE.PointLight(0xffa040, 0, 28, 1.7);
  campfireLight.name = 'campfire';
  scene.add(campfireLight);
  let campfireAt = null;

  // Auto-director + pop-out window. The director drives the same player pose the
  // controller does; any real input hands the camera back (see noteInput).
  const director = createDirector({
    onSubject: (handle) => onAction('directorSubject', handle),
    onCaption: (caption) => onAction('directorCaption', caption),
  });
  let lastInputAt = performance.now();
  // Once the player has actually touched the camera, the director waits this long before
  // taking it back — never the (much shorter) opening delay. Demo mode arms at 4 s so an
  // untouched kiosk cuts to the drama almost at once, and that same 4 s used to apply
  // after a look as well: the camera was yanked out of the player's hands a breath after
  // they stopped moving the mouse, which reads as the mouse not working at all.
  const DIRECTOR_RETAKE_SECONDS = 25;
  let everInteracted = false;
  // An explicit toggle-off (the 🎬 button, or C) is a preference, not a pause: without
  // this the auto-arm below re-enabled the director on the very next frame in demo mode,
  // because turning it off by hand never touched lastInputAt — so the switch did nothing
  // at all. Touching the mouse still only defers it; only the switch retires it.
  let directorDismissed = false;
  function setDirector(on) {
    if (director.enabled === !!on) return;
    director.setEnabled(on);
    if (on) followHandle = -1;
    onAction('director', !!on);
  }
  /** Mark player input without deciding what it means for the director. */
  function markInput(now = performance.now()) {
    lastInputAt = now;
    everInteracted = true;
  }
  function noteInput(now = performance.now()) {
    markInput(now);
    if (director.enabled) setDirector(false);
  }
  function toggleDirector() {
    const next = !director.enabled;
    markInput();
    directorDismissed = !next;
    setDirector(next);
  }
  const pip = createPip(canvas, { onChange: (on) => onAction('pip', on) });

  const input = createInput(canvas, {
    bindings,
    onLook: (dx, dy) => {
      if (dx || dy) { noteInput(); if (!told.look) { told.look = true; onAction('tour', 'look'); } }
      player.look(dx, dy);
    },
    onAction: (action, value) => {
      if (action === 'fly') { noteInput(); player.toggleFly(); return; }
      if (action === 'inspect') { noteInput(); onPick(hovered ? hovered.handle : -1); return; }
      if (action === 'director') { toggleDirector(); return; }
      if (action === 'pip') { pip.toggle(); return; }
      if (action === 'follow' || action === 'speed') noteInput();
      onAction(action, value);
    },
  });

  function resize() {
    const w = container.clientWidth || 1; const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    post.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  window.addEventListener('resize', resize);

  /**
   * Adaptive resolution (GFX option 9). onFps was already plumbed but only ever fed a
   * readout; this is what actually pays for the composer on a weak GPU. Scaling the
   * pixel ratio rather than dropping a pass keeps the LOOK identical and only the
   * sharpness moves, which is the least noticeable thing to give up.
   */
  function setDprScale(next) {
    const clamped = Math.max(DPR_FLOOR, Math.min(1, next));
    if (Math.abs(clamped - dprScale) < 0.01) return;
    dprScale = clamped;
    renderer.setPixelRatio(maxDpr * dprScale);
    post.setPixelRatio(maxDpr * dprScale);
    resize();
  }

  function setTerrain(msg) {
    if (island) { scene.remove(island.mesh, island.water); island.dispose(); }
    if (flora) flora.dispose();
    fireTiles = []; lavaTiles = [];
    const cs = msg.size + 1;
    terrainApi = {
      size: msg.size, height: msg.height, type: msg.tileType,
      heightAt(x, z) {
        if (x < 0 || z < 0 || x > msg.size || z > msg.size) return -3;
        const ix = Math.min(msg.size - 1, Math.floor(x)); const iz = Math.min(msg.size - 1, Math.floor(z));
        const fx = x - ix; const fz = z - iz; const o = iz * cs + ix;
        const top = msg.height[o] + (msg.height[o + 1] - msg.height[o]) * fx;
        const bottom = msg.height[o + cs] + (msg.height[o + cs + 1] - msg.height[o + cs]) * fx;
        return top + (bottom - top) * fz;
      },
    };
    island = createTerrainMesh(terrainApi, { tier });
    lighting.setWorldSize?.(msg.size);
    scene.add(island.mesh, island.water);
    flora = createFloraMeshes(scene, terrainApi, { trees: msg.trees, bushes: msg.bushes });
    if (minimapCanvas) minimap = createMinimap(minimapCanvas, terrainApi);
    if (settlementMeshes) settlementMeshes.dispose();
    settlementMeshes = createSettlementMeshes(scene, (x, z) => terrainApi.heightAt(x, z), palette);
    fauna?.dispose();
    fauna = createFauna(scene, terrainApi, { tier });
    // A pose set before the terrain arrived (Resume reads prefs synchronously at start)
    // must survive the rebuild, or the god is teleported back to the island's centre.
    // Fresh players float ('fly') until they press F to walk (2026-09-02 user call).
    const pending = pendingPose ?? (terrainReady ? player.pose() : null);
    pendingPose = null;
    terrainReady = true;
    // Spawn clear of trees, bushes, huts and boulders: the terrain message carries all four,
    // and the terrain is the only moment they are all in hand (see blockedTiles).
    const blocked = msg.tileState
      ? blockedTiles({ trees: msg.trees, bushes: msg.bushes, tileState: msg.tileState, size: terrainApi.size })
      : null;
    player = createPlayer(terrainApi, 'fly', blocked);
    if (pending) player.setPose(pending);
  }

  function setTiles(msg) {
    if (!island) return;
    island.paint(msg.tileState, msg.grass);
    flora?.update(msg, lastTime / 1000);
    minimap?.setTiles(msg);

    // One pass over the tile states per sync, converted straight to world points. Capped
    // because a full firestorm is 400 tiles and the emitter only ever samples a handful.
    // The campfire joins the fire list (it smokes) and parks the point light.
    const state = msg.tileState;
    fireTiles = []; lavaTiles = []; campfireAt = null;
    if (state && terrainApi) {
      const size = terrainApi.size;
      for (let t = 0; t < state.length; t++) {
        const s = state[t];
        if (s !== TILE_STATE.FIRE && s !== TILE_STATE.LAVA && s !== TILE_STATE.CAMPFIRE) continue;
        const x = (t % size) + 0.5; const z = Math.floor(t / size) + 0.5;
        const y = terrainApi.heightAt(x, z);
        if (s === TILE_STATE.CAMPFIRE) { if (!campfireAt) { campfireAt = { x, y, z }; fireTiles.push(campfireAt); } continue; }
        const list = s === TILE_STATE.FIRE ? fireTiles : lavaTiles;
        if (list.length >= 96) continue;
        list.push({ x, y, z });
      }
    }
  }

  function acceptFrame(buffer, recycle) {
    lastRecycle = recycle;
    // The sim's creature cap is the world's, not ours: a low-end (phone) world runs 250 while
    // this renderer is sized for CREATURE_CAP, and reading a 250-row buffer as 400 rows threw
    // a RangeError on every frame, so phones drew no creatures at all. The row count is
    // recovered from the buffer itself (the layout in sim/frame.js), capped at ours.
    const rows = (buffer.byteLength - FRAME.HEADER_INTS * 4 - propCap * FRAME.PROP_STRIDE * 4) / (4 + FRAME.CREATURE_STRIDE * 4);
    const views = frameViews(buffer, Math.min(cap, rows | 0), propCap);
    if (curr) { if (prev) recycle(prev.buffer); prev = curr; prevAt = currAt; }
    curr = { buffer, views };
    currAt = performance.now();
    if (!prev) prevAt = currAt;   // no previous frame: anchor the interpolation clock
  }

  function interpolate(now) {
    if (!curr) return;
    const c = curr.views;
    const count = c.header[FRAME.H_COUNT];
    const p = prev?.views;
    const span = Math.max(1, currAt - prevAt);
    const alpha = p ? Math.min(1.4, (now - currAt) / span + 1) : 1;   // extrapolate slightly past the last frame
    interpCount = count;
    propCount = c.header[FRAME.H_PROPS];
    for (let k = 0; k < count; k++) {
      const o = k * FRAME.CREATURE_STRIDE;
      // Match rows by handle: the sim's order is stable within a tick but births/deaths shift it.
      let po = -1;
      if (p) { const h = c.handles[k]; if (p.handles[k] === h) po = o; else { for (let j = 0; j < p.header[FRAME.H_COUNT]; j++) if (p.handles[j] === h) { po = j * FRAME.CREATURE_STRIDE; break; } } }
      if (po < 0) { for (let f = 0; f < FRAME.CREATURE_STRIDE; f++) interp[o + f] = c.creatures[o + f]; speeds[k] = 0; continue; }
      const t = alpha;
      const px = p.creatures[po]; const pz = p.creatures[po + 2];
      interp[o] = px + (c.creatures[o] - px) * t;
      interp[o + 1] = p.creatures[po + 1] + (c.creatures[o + 1] - p.creatures[po + 1]) * t;
      interp[o + 2] = pz + (c.creatures[o + 2] - pz) * t;
      interp[o + 3] = p.creatures[po + 3] + shortestAngle(p.creatures[po + 3], c.creatures[o + 3]) * t;
      for (let f = 4; f < FRAME.CREATURE_STRIDE; f++) interp[o + f] = c.creatures[o + f];
      speeds[k] = Math.hypot(c.creatures[o] - px, c.creatures[o + 2] - pz) * (1000 / span);
    }
  }

  /**
   * Where the sun lands on screen, and how hard it should scatter. Shafts are skipped
   * outright when the sun is behind the camera — marching toward a projected point that is
   * really behind you produces streaks in exactly the wrong direction.
   */
  function updateShafts(sky, dir) {
    if (!post.enabled) return;
    // camera.lookAt has just moved the camera but matrixWorldInverse is only refreshed
    // inside render(), so without this the shafts would trail the view by a frame.
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    sunView.copy(lighting.sun.position).applyMatrix4(camera.matrixWorldInverse);
    if (sunView.z >= -0.5) { post.setSun(null, 0); return; }      // three looks down -z
    sunNdc.copy(lighting.sun.position).project(camera);
    const off = Math.max(Math.abs(sunNdc.x), Math.abs(sunNdc.y));
    const edge = 1 - smoothstep(0.75, 1.7, off);
    if (edge <= 0.01) { post.setSun(null, 0); return; }

    sunFromCam.copy(lighting.sun.position).sub(camera.position).normalize();
    const facing = Math.max(0, dir.x * sunFromCam.x + dir.y * sunFromCam.y + dir.z * sunFromCam.z);

    // Shafts belong to a low sun. At noon the light is overhead, there is nothing for it to
    // rake across, and a strong pass just fogs the frame.
    const hour = 0.2 + sky.dusk * 0.95 + sky.day * 0.2;
    sunUv.set(sunNdc.x * 0.5 + 0.5, sunNdc.y * 0.5 + 0.5);
    post.setSun(sunUv, Math.min(1.1, facing * facing * edge * hour), sky.sunColour);
  }

  /** Rain and snow, emitted in a column above the god so the weather is always on screen. */
  function emitWeather(dt) {
    if (!particles.enabled || weatherIntensity <= 0.02) return;
    const k = weatherKind;
    if (k !== 1 && k !== 2 && k !== 4) return;
    const perSecond = (k === 4 ? 70 : k === 2 ? 420 : 260) * weatherIntensity * (tier === 'medium' ? 0.6 : 1);
    rainDebt += dt * perSecond;
    const n = Math.min(40, Math.floor(rainDebt));
    rainDebt -= n;
    const kind = k === 4 ? 'snow' : 'rain';
    const top = player.y + (k === 4 ? 10 : 14);
    for (let q = 0; q < n; q++) {
      const x = player.x + (Math.random() - 0.5) * 44; const z = player.z + (Math.random() - 0.5) * 44;
      particles.emit(kind, x, top + Math.random() * 4, z, { count: 1, dir: [k === 2 ? 0.12 : 0.04, -1, 0.05], spread: k === 4 ? 0.5 : 0.06 });
    }
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0);
    lastTime = now;
    const timeSec = now / 1000;
    frames++;
    if (now - fpsAt >= 1000) {
      fps = frames * 1000 / (now - fpsAt); frames = 0; fpsAt = now; onFps(fps);
      if (fps < DPR_DOWN_FPS) { slowSeconds++; fastSeconds = 0; } else if (fps > DPR_UP_FPS) { fastSeconds++; slowSeconds = 0; } else { slowSeconds = 0; fastSeconds = 0; }
      if (slowSeconds >= DPR_DOWN_SECONDS) { setDprScale(dprScale - 0.12); slowSeconds = 0; }
      else if (fastSeconds >= DPR_UP_SECONDS && dprScale < 1) { setDprScale(dprScale + 0.08); fastSeconds = 0; }
    }

    interpolate(now);

    // The director needs this frame's creature rows, so the pose is stepped after the
    // interpolation and the direction is read once the pose is final.
    const intent = input.consume();
    if (terrainApi) {
      if (intent.forward || intent.right || intent.up || intent.jump) {
        noteInput(now);
        if (!told.move) { told.move = true; onAction('tour', 'move'); }
      } else if (directorIdleSeconds > 0 && !director.enabled && !directorDismissed && !directorHeld
        && now - lastInputAt > (everInteracted ? Math.max(directorIdleSeconds, DIRECTOR_RETAKE_SECONDS) : directorIdleSeconds) * 1000) setDirector(true);
      const driven = director.enabled && curr
        && director.update(dt, timeSec, { player, terrain: terrainApi, interp, handles: curr.views.handles, count: interpCount });
      if (!driven) stepPlayer(player, intent, dt, terrainApi);
    }
    // The camera is re-seated on EVERY frame, terrain or not. It used to live inside the
    // branch above, which meant that while the world was still loading — or never arrived
    // at all — look input moved the pose and nothing moved the camera, so the mouse read
    // as broken rather than as early. The player exists from construction (a flat stand-in
    // heightmap), so this is always a valid pose.
    const dir = player.direction();
    camera.position.set(player.x, player.y, player.z);
    camera.lookAt(player.x + dir.x, player.y + dir.y, player.z + dir.z);
    // The listener follows the UNSHAKEN pose: a camera shake is a lens artefact, and
    // panning the world's audio with it would make an eruption sound like vertigo.
    if (terrainApi) audio?.setPlayer(player, dir);

    if (curr) {
      // Follow: gently tether the god behind the followed creature (the director has its own tether).
      if (followHandle >= 0 && !director.enabled) {
        for (let k = 0; k < interpCount; k++) {
          if (curr.views.handles[k] !== followHandle) continue;
          const o = k * FRAME.CREATURE_STRIDE;
          const tx = interp[o] - Math.sin(player.yaw) * 6; const tz = interp[o + 2] - Math.cos(player.yaw) * 6;
          player.x += (tx - player.x) * Math.min(1, dt * 2);
          player.z += (tz - player.z) * Math.min(1, dt * 2);
          break;
        }
      }
      creatures.draw(interp, interpCount, timeSec, speeds);
      props.draw(curr.views.props, propCount);
      // Only on a frame the sim actually produced: see eventFx.props for why feeding it
      // repeated rows would read every falling body as one that had just landed.
      const tick = curr.views.header[FRAME.H_TICK];
      if (tick !== lastPropTick) { lastPropTick = tick; eventFx.props(curr.views.props, propCount, currAt, terrainApi); }
      hovered = pickCreature(camera.position, dir, interp, curr.views.handles, interpCount);
      minimap?.draw(interp, interpCount, player);
    }

    const overcast = (OVERCAST[weatherKind] ?? 0) * weatherIntensity;
    skyDome.setOvercast(overcast);
    const sky = lighting.update(stats?.dayFraction ?? 0.5, player, timeSec, skyDome.overcast);
    scene.background = sky.sky;
    materialClock.value = timeSec;
    if (stats && stats.season !== undefined) {
      materialSeason.value = stats.season;
      materialSnow.value = stats.season === 3 ? 0.75 : (stats.season === 0 ? Math.max(0.0, 0.75 - (stats.seasonProgress ?? 0) * 2.5) : 0.0);
    }
    skyDome.update(sky, player, timeSec);
    island?.update(timeSec, sky);
    if (campfireAt) {
      campfireLight.position.set(campfireAt.x, campfireAt.y + 1.1, campfireAt.z);
      const flicker = 0.85 + 0.15 * Math.sin(timeSec * 11.3) * Math.sin(timeSec * 7.1);
      campfireLight.intensity = (14 + (sky.night ?? 0) * 70) * flicker;
    } else campfireLight.intensity = 0;

    eventFx.ambient(dt, { fireTiles, lavaTiles, player, dayFraction: stats?.dayFraction ?? 0.5 });
    emitWeather(dt);
    fauna?.update(dt, timeSec, { player, night: sky.night ?? 0, storm: weatherKind === WEATHER_STORM ? weatherIntensity : 0 });
    particles.update(dt, {
      fogColor: sky.sky, fogDensity: sky.fogDensity,
      pixelHeight: renderer.domElement.height, fov: camera.fov,
    });

    post.setNight(sky.night, sky.dusk);
    updateShafts(sky, dir);
    post.update(dt);
    // Shake LAST, after everything that reads the camera has read it: applyCameraShake
    // offsets in the camera's own basis and is recomputed from scratch each frame, so it
    // must not be applied before the audio listener or the shaft projection. Still gated
    // on terrainApi, though the re-seat above is now unconditional: every shake is raised
    // by a sim event, and there are none before a world exists.
    if (terrainApi && !motionReduced) applyCameraShake(camera, timeSec, 0.55);
    post.render();
    pip.mirror();
    // While the world is popped out, the pop-out window's frame clock drives the loop:
    // a hidden tab's own requestAnimationFrame never fires.
    pip.raf(frame);
  }
  requestAnimationFrame(frame);

  // A lost GL context (driver reset, GPU process crash, too many contexts) stops every draw
  // dead. preventDefault is what makes the browser offer a restore at all; the engine
  // answers 'contextRestored' by rebuilding the renderer from the cached terrain and tiles,
  // because every GPU resource this module made is gone with the context.
  const onContextLost = (e) => { e.preventDefault(); contextLost = true; running = false; onAction('contextLost'); };
  const onContextRestored = () => { onAction('contextRestored'); };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  return {
    canvas, scene, camera, renderer, particles,
    get player() { return player.pose(); },
    get playerState() { return player; },
    get fps() { return fps; },
    get dprScale() { return dprScale; },
    get tier() { return tier; },
    get hovered() { return hovered; },
    get locked() { return input.locked; },
    setTerrain, setTiles, acceptFrame,
    setStats(s) {
      stats = s;
      if (s?.weather) {
        weatherKind = s.weather.kind | 0; weatherIntensity = s.weather.intensity ?? 0;
        audio?.setWeather?.(weatherKind, weatherIntensity);
      }
      if (settlementMeshes && s?.buildings) {
        settlementMeshes.syncBuildings(s.buildings);
      }
    },
    /** A drained sim event: routed to particles, the camera, the ear and the director. */
    onEvent(ev) {
      if (!ev || ev.tile === undefined || ev.tile < 0 || !terrainApi) return;
      const at = eventFx.worldOf(ev.tile, terrainApi, terrainApi.size);
      eventFx.event(ev, at, player, post);
      if (director.enabled) director.cut(at.x, at.z, EVENT_CAPTIONS[ev.kind] ?? ev.text ?? '', lastTime / 1000);
    },
    // Selection is the sim's and the page's business, not the renderer's: nothing is
    // drawn differently for the inspected creature since the wireframe box went
    // (creatureMeshes.js). Kept as a no-op so the engine API stays one shape.
    select() {},
    follow(handle) { if (handle >= 0) noteInput(); followHandle = handle ?? -1; },
    setTint: (traitIndex) => creatures.setTint(traitIndex),
    get tint() { return creatures.tint; },
    // The page's 🎬 button goes through the same switch the C key does, so an explicit
    // off is remembered rather than undone by the idle timer.
    setDirector(on) { if (director.enabled === !!on) return; toggleDirector(); },
    get director() { return director.enabled; },
    get directorCaption() { return director.caption; },
    togglePip: () => pip.toggle(),
    get pipActive() { return pip.active; },
    setPose(pose) { if (terrainReady) player.setPose(pose); else pendingPose = pose; },
    /** Park the camera looking at a world point from 26 m back and 22 m up (timeline, tribes). */
    flyTo(x, z) {
      noteInput();
      const h = terrainApi ? Math.max(0, terrainApi.heightAt(x, z)) : 0;
      const pose = { x, y: h + 22, z: Math.max(1, z - 26), yaw: 0, pitch: -0.62, mode: 'fly' };
      if (terrainReady) player.setPose(pose); else pendingPose = pose;
    },
    /** Hold the director off (true) or release it (false). A held director is also switched off. */
    holdDirector(on) { directorHeld = !!on; if (directorHeld && director.enabled) setDirector(false); },
    setBindings: (b) => input.setBindings(b),
    setReducedMotion(on) { motionReduced = !!on; },
    get contextLost() { return contextLost; },
    get faunaInfo() { return { birds: fauna?.birdCount ?? 0, fishSchools: fauna?.fishSchools ?? 0 }; },
    touchMove: (x, z) => input.setTouchVector(x, z),
    touchRelease: () => input.releaseTouch(),
    toggleFly: () => player.toggleFly(),
    requestLock: () => canvas.requestPointerLock?.(),
    dispose() {
      running = false;
      // The two frames held for interpolation belong to the worker's pool of three; a
      // renderer rebuilt without returning them (quality change, context restore) would
      // leave the sim one buffer short, and it skips frames when the pool is empty.
      if (lastRecycle) { if (prev) lastRecycle(prev.buffer); if (curr) lastRecycle(curr.buffer); }
      prev = null; curr = null;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      fauna?.dispose();
      observer.disconnect();
      window.removeEventListener('resize', resize);
      input.dispose();
      pip.dispose();
      scene.remove(campfireLight);
      settlementMeshes?.dispose();
      creatures.dispose(); props.dispose(); flora?.dispose(); island?.dispose(); lighting.dispose(); skyDome.dispose(); minimap?.dispose();
      particles.dispose(); post.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
