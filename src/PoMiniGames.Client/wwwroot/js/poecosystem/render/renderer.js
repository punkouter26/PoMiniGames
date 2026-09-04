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
import { createPlayer, stepPlayer } from './playerController.js';
import { createInput } from './input.js';
import { pickCreature } from './picking.js';
import { createPostProcess } from './postProcess.js';
import { createParticles } from './particles.js';
import { createEventFx } from './eventFx.js';
import { applyCameraShake } from '../../postFx.js';

const TAU = Math.PI * 2;
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
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'poeco-canvas';
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:crosshair;';
  container.appendChild(canvas);

  // PoQuality is the app's quality authority (?fx= override, reduced-motion cap, battery
  // demotion, fps watchdog); the core count is only the fallback when it has not loaded.
  const lowEnd = quality.lowEnd ?? (window.PoQuality ? window.PoQuality.tier() === 'low' : (navigator.hardwareConcurrency ?? 8) <= 4);
  // One tier string, resolved once, handed to every subsystem. `lowEnd` from the caller is
  // an override that can only demote — a Blazor-side low-end hint must not be undone by a
  // machine that happens to report a fast GPU.
  const tier = lowEnd ? 'low' : (window.PoQuality?.tier?.() ?? 'high');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowEnd, powerPreference: 'high-performance' });
  const maxDpr = window.PoCanvasDpr?.ceiling ? window.PoCanvasDpr.ceiling(lowEnd ? 1 : 2) : Math.min(devicePixelRatio || 1, lowEnd ? 1 : 2);
  let dprScale = 1;
  renderer.setPixelRatio(maxDpr);
  renderer.shadowMap.enabled = !lowEnd;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 700);
  // lighting owns scene.fog now: its colour and density both ride the same day/night curve
  // as the sky, and the water and particle shaders read the density back off it.
  const lighting = createLighting(scene, { shadows: !lowEnd, shadowMapSize: lowEnd ? 1024 : 2048, tier });
  const creatures = createCreatureMeshes(scene, cap);
  const props = createPropMeshes(scene, propCap);
  const particles = createParticles(scene, { tier });
  const eventFx = createEventFx(scene, particles, audio, { tier });
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

  // Two frames + their views, for interpolation.
  let prev = null; let curr = null; let prevAt = 0; let currAt = 0;
  const interp = new Float32Array(cap * FRAME.CREATURE_STRIDE);
  const speeds = new Float32Array(cap);
  let interpCount = 0;
  let propCount = 0;
  let selectedHandle = -1;
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

  const input = createInput(canvas, {
    onLook: (dx, dy) => player.look(dx, dy),
    onAction: (action, value) => {
      if (action === 'fly') { player.toggleFly(); return; }
      if (action === 'inspect') { onPick(hovered ? hovered.handle : -1); return; }
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
    scene.add(island.mesh, island.water);
    flora = createFloraMeshes(scene, terrainApi, { trees: msg.trees, bushes: msg.bushes });
    if (minimapCanvas) minimap = createMinimap(minimapCanvas, terrainApi);
    // A pose set before the terrain arrived (Resume reads prefs synchronously at start)
    // must survive the rebuild, or the god is teleported back to the island's centre.
    // Fresh players float ('fly') until they press F to walk (2026-09-02 user call).
    const pending = pendingPose ?? (terrainReady ? player.pose() : null);
    pendingPose = null;
    terrainReady = true;
    player = createPlayer(terrainApi, 'fly');
    if (pending) player.setPose(pending);
  }

  function setTiles(msg) {
    if (!island) return;
    island.paint(msg.tileState, msg.grass);
    flora?.update(msg, lastTime / 1000);
    minimap?.setTiles(msg);

    // One pass over the tile states per sync, converted straight to world points. Capped
    // because a full firestorm is 400 tiles and the emitter only ever samples a handful.
    const state = msg.tileState;
    fireTiles = []; lavaTiles = [];
    if (state && terrainApi) {
      const size = terrainApi.size;
      for (let t = 0; t < state.length; t++) {
        const s = state[t];
        if (s !== TILE_STATE.FIRE && s !== TILE_STATE.LAVA) continue;
        const list = s === TILE_STATE.FIRE ? fireTiles : lavaTiles;
        if (list.length >= 96) continue;
        const x = (t % size) + 0.5; const z = Math.floor(t / size) + 0.5;
        list.push({ x, y: terrainApi.heightAt(x, z), z });
      }
    }
  }

  function acceptFrame(buffer, recycle) {
    const views = frameViews(buffer, cap, propCap);
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

    // One direction() call per frame: it allocates, and the camera, the audio listener,
    // the picker and the shaft projection all want the same answer.
    const dir = player.direction();
    if (terrainApi) {
      stepPlayer(player, input.consume(), dt, terrainApi);
      camera.position.set(player.x, player.y, player.z);
      camera.lookAt(player.x + dir.x, player.y + dir.y, player.z + dir.z);
      // The listener follows the UNSHAKEN pose: a camera shake is a lens artefact, and
      // panning the world's audio with it would make an eruption sound like vertigo.
      audio?.setPlayer(player, dir);
    }

    interpolate(now);

    if (curr) {
      // Follow: gently tether the god behind the followed creature.
      if (followHandle >= 0) {
        for (let k = 0; k < interpCount; k++) {
          if (curr.views.handles[k] !== followHandle) continue;
          const o = k * FRAME.CREATURE_STRIDE;
          const tx = interp[o] - Math.sin(player.yaw) * 6; const tz = interp[o + 2] - Math.cos(player.yaw) * 6;
          player.x += (tx - player.x) * Math.min(1, dt * 2);
          player.z += (tz - player.z) * Math.min(1, dt * 2);
          break;
        }
      }
      let selectedIndex = -1;
      if (selectedHandle >= 0) for (let k = 0; k < interpCount; k++) if (curr.views.handles[k] === selectedHandle) { selectedIndex = k; break; }
      creatures.draw(interp, interpCount, selectedIndex, timeSec, speeds);
      props.draw(curr.views.props, propCount);
      // Only on a frame the sim actually produced: see eventFx.props for why feeding it
      // repeated rows would read every falling body as one that had just landed.
      const tick = curr.views.header[FRAME.H_TICK];
      if (tick !== lastPropTick) { lastPropTick = tick; eventFx.props(curr.views.props, propCount, currAt, terrainApi); }
      hovered = pickCreature(camera.position, dir, interp, curr.views.handles, interpCount);
      minimap?.draw(interp, interpCount, player);
    }

    const sky = lighting.update(stats?.dayFraction ?? 0.5, player, timeSec);
    scene.background = sky.sky;
    island?.update(timeSec, sky);

    eventFx.ambient(dt, { fireTiles, lavaTiles, player, dayFraction: stats?.dayFraction ?? 0.5 });
    eventFx.update(dt);
    particles.update(dt, {
      fogColor: sky.sky, fogDensity: sky.fogDensity,
      pixelHeight: renderer.domElement.height, fov: camera.fov,
    });

    post.setNight(sky.night);
    updateShafts(sky, dir);
    post.update(dt);
    // Shake LAST, after everything that reads the camera has read it: applyCameraShake
    // offsets in the camera's own basis and is recomputed from scratch each frame, so it
    // must not be applied before the audio listener or the shaft projection. Gated on
    // terrainApi because that is the branch which re-seats the camera on the player — an
    // offset applied to a camera nobody is repositioning would accumulate.
    if (terrainApi) applyCameraShake(camera, timeSec, 0.55);
    post.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

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
    setStats(s) { stats = s; },
    /** A drained sim event: routed to particles, the flash light, the camera and the ear. */
    onEvent(ev) {
      if (!ev || ev.tile === undefined || !terrainApi) return;
      eventFx.event(ev, eventFx.worldOf(ev.tile, terrainApi, terrainApi.size), player, post);
    },
    select(handle) { selectedHandle = handle ?? -1; },
    follow(handle) { followHandle = handle ?? -1; },
    setPose(pose) { if (terrainReady) player.setPose(pose); else pendingPose = pose; },
    touchMove: (x, z) => input.setTouchVector(x, z),
    touchRelease: () => input.releaseTouch(),
    toggleFly: () => player.toggleFly(),
    requestLock: () => canvas.requestPointerLock?.(),
    dispose() {
      running = false;
      observer.disconnect();
      window.removeEventListener('resize', resize);
      input.dispose();
      creatures.dispose(); props.dispose(); flora?.dispose(); island?.dispose(); lighting.dispose(); minimap?.dispose();
      eventFx.dispose(); particles.dispose(); post.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
