// renderer.js — the three.js side: owns the scene, the camera the player controller
// drives, the frame interpolation, and the render loop.
//
// Frames arrive at 20 Hz and are drawn at display rate, so two frames are kept and
// positions/yaws are interpolated between them; every frame buffer is returned to the sim
// worker as soon as its data has been copied out, which is what keeps the pool from
// running dry (see host/simRuntime.js).
import * as THREE from 'three';
import { CREATURE_CAP, PROP_CAP } from '../sim/core/config.js';
import { FRAME, frameViews } from '../sim/frame.js';
import { createTerrainMesh } from './terrainMesh.js';
import { createLighting } from './lighting.js';
import { createCreatureMeshes } from './creatureMeshes.js';
import { createPropMeshes } from './propMeshes.js';
import { createFloraMeshes } from './floraMeshes.js';
import { createMinimap } from './minimap.js';
import { createPlayer, stepPlayer, PLAYER } from './playerController.js';
import { createInput } from './input.js';
import { pickCreature } from './picking.js';

const TAU = Math.PI * 2;
const shortestAngle = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };

export function createRenderer(container, {
  cap = CREATURE_CAP, propCap = PROP_CAP, minimapCanvas = null, quality = {},
  onPick = () => {}, onAction = () => {}, onFps = () => {},
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'poeco-canvas';
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:crosshair;';
  container.appendChild(canvas);

  const lowEnd = quality.lowEnd ?? ((navigator.hardwareConcurrency ?? 8) <= 4);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowEnd, powerPreference: 'high-performance' });
  const maxDpr = window.PoCanvasDpr?.ceiling ? window.PoCanvasDpr.ceiling(lowEnd ? 1 : 2) : Math.min(devicePixelRatio || 1, lowEnd ? 1 : 2);
  renderer.setPixelRatio(maxDpr);
  renderer.shadowMap.enabled = !lowEnd;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x8ec5ff, 60, 320);
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 700);
  const lighting = createLighting(scene, { shadows: !lowEnd, shadowMapSize: lowEnd ? 1024 : 2048 });
  const creatures = createCreatureMeshes(scene, cap);
  const props = createPropMeshes(scene, propCap);

  // terrainApi mirrors the sim terrain's read API (heightAt/type) from the transferred arrays.
  let terrainApi = null;       // heightAt/type lookups the controller needs
  let island = null;
  let flora = null;
  let minimap = null;
  let player = createPlayer({ size: 200, heightAt: () => 0, type: new Uint8Array(200 * 200) });

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
  let lastTime = 0;

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
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  window.addEventListener('resize', resize);

  function setTerrain(msg) {
    if (island) { scene.remove(island.mesh, island.water); island.dispose(); }
    if (flora) flora.dispose();
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
    island = createTerrainMesh(terrainApi);
    scene.add(island.mesh, island.water);
    flora = createFloraMeshes(scene, terrainApi, { trees: msg.trees, bushes: msg.bushes });
    if (minimapCanvas) minimap = createMinimap(minimapCanvas, terrainApi);
    player = createPlayer(terrainApi);
  }

  function setTiles(msg) {
    if (!island) return;
    island.paint(msg.tileState, msg.grass);
    flora?.update(msg, lastTime / 1000);
    minimap?.setTiles(msg);
  }

  function acceptFrame(buffer, recycle) {
    const views = frameViews(buffer, cap, propCap);
    if (curr) { if (prev) recycle(prev.buffer); prev = curr; prevAt = currAt; }
    curr = { buffer, views };
    currAt = performance.now();
    if (!prev) { prev = null; prevAt = currAt; }
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

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0);
    lastTime = now;
    frames++;
    if (now - fpsAt >= 1000) { fps = frames * 1000 / (now - fpsAt); frames = 0; fpsAt = now; onFps(fps); }

    if (terrainApi) {
      stepPlayer(player, input.consume(), dt, terrainApi);
      camera.position.set(player.x, player.y, player.z);
      const dir = player.direction();
      camera.lookAt(player.x + dir.x, player.y + dir.y, player.z + dir.z);
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
      creatures.draw(interp, interpCount, selectedIndex, now / 1000, speeds);
      props.draw(curr.views.props, propCount);
      hovered = pickCreature(camera.position, player.direction(), interp, curr.views.handles, interpCount);
      minimap?.draw(interp, interpCount, player);
    }

    const sky = lighting.update(stats?.dayFraction ?? 0.5, player);
    scene.background = sky;
    if (scene.fog) scene.fog.color.copy(sky);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    canvas, scene, camera, renderer,
    get player() { return player.pose(); },
    get playerState() { return player; },
    get fps() { return fps; },
    get hovered() { return hovered; },
    get locked() { return input.locked; },
    setTerrain, setTiles, acceptFrame,
    setStats(s) { stats = s; },
    select(handle) { selectedHandle = handle ?? -1; },
    follow(handle) { followHandle = handle ?? -1; },
    setPose(pose) { player.setPose(pose); },
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
      renderer.dispose();
      canvas.remove();
    },
  };
}

export { PLAYER };
