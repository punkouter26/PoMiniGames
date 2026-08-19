// game.js — PoVoxelStrike engine core. M3 scope: the full survival loop — enemies
// escalate forever, the gun heats, debris crushes both sides, death ends the run.
//
// Input contract (PRD §4.3): during play the CANVAS owns raw input under Pointer Lock.
// Losing the lock for any reason (Esc, tab switch) pauses the simulation and hands the
// overlay to Blazor via OnPaused; Resume re-acquires the lock from the button's click
// gesture. The engine's own veil appears only before the first lock of a run.
//
// Interop contract (PRD §4.2): a 10 Hz OnHudTick pump of flat primitives (positional,
// same convention as PoMarbleRace — no DTOs across the boundary), plus the discrete
// lifecycle events OnReady / OnResumed / OnPaused / OnGameOver / OnFatalError. Never
// per-frame.
//
// Co-op mode (multiplayer slice, 2026-08-18): when the engine is constructed with
// `mode: 'multi'`, the local player's inputs are sampled at the platform's lockstep
// tick rate (20 Hz) and shipped to `multiplayerSink(batch)`. The server stamps a tick
// number and relays every peer's batch back; the engine applies the batches in
// PlayerNumber order. The server is NOT authoritative for the simulation — clients
// run identical local engines, the server just relays inputs. Determinism is the
// client's responsibility.
//
// ARG ORDER IS A CONTRACT. The positional lists below mirror [JSInvokable] methods in
// PoVoxelStrikePage.razor — reorder/insert on BOTH sides or the binder mis-assigns:
//   OnHudTick(hp, heatPct, heatLocked, altPct, score, elapsed, kills, enemyCount,
//             bodies, particles)
//   OnGameOver(score, survivalSeconds, kills, bruteKills, crushKills,
//              voxelsDestroyed, seed)          ← new args go at the END only
//   OnReady(assetCount, structureCount) · OnResumed() · OnPaused(reason)
//   OnFatalError(message)

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { buildWorld, ARENA_HALF } from './world.js';
import { DebrisManager } from './debris.js';
import { Weapon } from './combat.js';
import { EnemyManager } from './enemies.js';
import { VoxelAudio } from './audio.js';
import { Vfx } from './vfx.js';
import { resolveQuality, createRenderer } from './quality.js';
import { setQuality, createActorMaterial, SkyEnvironment } from './materials.js';
import { ParticleSystem } from './particles.js';
import { DecalField } from './decals.js';
import { FortressGuns, Chalice } from './fortress.js';
import { ShrapnelField } from './shrapnel.js';
import { createPhysicsWorld, PHYSICS_STEP as SI_PHYSICS_STEP } from './physics.js';

const EYE_HEIGHT = 1.6;
const CAM_DISTANCE = 7;
const WALK_SPEED = 9;
const RUN_SPEED = 16;
const PHYSICS_STEP = SI_PHYSICS_STEP;
// The player is a rigid body now (see _buildPlayerBody). A sphere, not a capsule:
// cannon-es has no capsule primitive, and a single sphere at the hips with a ground probe
// underneath is the standard, robust way to do this — it cannot catch its corners on a
// voxel edge the way a box does, and every FPS controller built on cannon works this way.
const PLAYER_RADIUS = 0.45;
const PLAYER_MASS = 80;                 // kg
const PLAYER_EYE_ABOVE_CENTRE = 0.75;
// How high a ledge the player walks up without jumping. 0.6 m is a tall step; the old
// code allowed 2.2 m, which is a wall.
const STEP_HEIGHT = 0.6;
const GROUND_PROBE = PLAYER_RADIUS + 0.25;
// Collision groups. Everything in the world is group 1; the player alone is group 2, so
// the ground probe can ray against the world without hitting the body it starts inside.
const WORLD_GROUP = 1;
const PLAYER_GROUP = 2;
const HUD_INTERVAL_S = 0.1;
// Taking the chalice is the win, so it has to out-score any amount of grinding: a long
// survival run tops out around 20 k, and a siege that ends in a breach should always read
// as the better result on the board.
const VICTORY_BONUS = 25000;
// Chunks the whole fortress may re-mesh per frame for LOD changes. Greedy meshing made a
// chunk cheap, but 44 structures changing band at once is still 800 of them.
const REMESH_CHUNKS_PER_FRAME = 6;
// Half-width of the sun's shadow window, in metres, centred ahead of the player.
const SHADOW_HALF_M = 45;
// Physics streaming: static collider bodies further than this from the player are taken
// out of the world entirely, and re-added on approach. Measured first at 120 m, which
// combined with each piece's own extent covered the whole 180 m arena and streamed out
// precisely nothing. 70 m is past anything the player is standing on or that debris near
// them can reach; carving and shooting are unaffected either way, because those read the
// voxel grid directly rather than the physics world.
const PHYSICS_STREAM_RADIUS_M = 70;
const PHYSICS_STREAM_INTERVAL_S = 0.5;
// Floor for dynamic resolution. Below this the picture is soft enough that the frames are
// not worth having.
const MIN_RENDER_SCALE = 0.6;
// Kiosk siege AI (demo mode). Tuned so the attract loop reads clearly from across a room:
// the bot should visibly stop at a wall, chew through it, and walk in.
const DEMO_PROBE_RANGE = 14;        // metres of "is something in my way"
const DEMO_BLAST_RANGE = 11;        // only lob the blast ball at something it can reach
const DEMO_BLAST_COOLDOWN_S = 4;
const DEMO_REACH_RADIUS = 5.5;      // close enough to the chalice to count as taken
// How far ahead the bot digs when it is stuck and the probe rays found nothing.
const DEMO_FORCE_DISTANCE = 4;
const DEMO_TRIUMPH_S = 5;
const PLAYER_MAX_HP = 100;
const PLAYER_CRUSH_MIN_SPEED = 5;

export class Engine {
  constructor(host, dotnetRef, demo, volumes, mode = 'solo') {
    this.host = host;
    this.dotnetRef = dotnetRef;
    this.demo = demo;
    this.volumes = volumes;
    // 'solo' (default) or 'multi'. Multi enables the lockstep input shipper.
    this.mode = mode === 'multi' ? 'multi' : 'solo';
    this.multiplayerSink = null;
    this.multiplayerPlayerNumber = 1;
    this._lockstepClock = 0;
    this._lockstepTick = 0;
    // Multiplayer slice, 2026-08-18: same tick rate as the server pump
    // (PoVoxelStrikeLockstepService.TickIntervalMs = 50). Drift-corrected in the frame
    // loop below — see _frame().
    this._lockstepIntervalMs = 50;

    this.disposed = false;
    this.running = false;
    this.state = 'playing'; // 'playing' | 'paused' | 'dead'
    // World seed (PRD §F3): generated per run, surfaced in OnGameOver so the run
    // summary can show it. Hex keeps it short enough to read aloud.
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.everLocked = false;
    this.rafId = 0;
    this.lastTime = 0;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = -0.25;

    // Run stats (PRD §F7 score formula).
    this.hp = PLAYER_MAX_HP;
    this.elapsed = 0;
    this.kills = 0;
    this.bruteKills = 0;
    this.crushKills = 0;
    this.voxelsDestroyed = 0;
    this.hudClock = 0;

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      // Keyboard fire (user request: trackpad users shouldn't need mouse buttons):
      // F digs (hold = held primary fire), G blasts. Mouse buttons still work too.
      if (this._locked() && this.state === 'playing') {
        if (e.code === 'KeyF') this.weapon.setPrimaryHeld(true);
        if (e.code === 'KeyG') this.weapon.fireAlt(this._muzzle());
      }
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyF') this.weapon?.setPrimaryHeld(false);
    };
    this._onMouseMove = (e) => this._look(e.movementX, e.movementY);
    this._onMouseDown = (e) => this._mouseButton(e, true);
    this._onMouseUp = (e) => this._mouseButton(e, false);
    this._onContextMenu = (e) => { if (this._locked()) e.preventDefault(); };
    this._onPointerLockChange = () => this._lockChanged();
    this._onClick = () => {
      if (!this._locked() && !this.demo && this.state === 'playing') this.canvas.requestPointerLock();
    };
  }

  /**
   * Async because the renderer is: the WebGPU path has to await adapter init before it
   * can report whether it came up. index.js awaits this; nothing else may assume the
   * engine is usable the instant the constructor returns.
   */
  async start() {
    const width = this.host.clientWidth || 800;
    const height = this.host.clientHeight || 480;

    // Resolve the GFX tier FIRST and publish it: world geometry is built further down
    // this method and every material it creates reads the tier through materials.js.
    this.q = resolveQuality();
    setQuality(this.q);

    // MSAA is redundant once SMAA is in the chain, and the two together cost twice for
    // one result — so the tier that turns SMAA on turns hardware AA off.
    const built = await createRenderer({ antialias: !this.q.smaa });
    if (this.disposed) { built.renderer.dispose?.(); return; }
    this.renderer = built.renderer;
    this.rendererApi = built.api;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // PBR wants a filmic curve and a linear working space; without tone mapping the
    // sun-lit faces of a white cottage clip to flat white the moment the sun is up.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // ACES rolls highlights off hard, so a "correct" exposure of 1.0 reads as gloomy in a
    // scene made almost entirely of mid-grey stone. 1.2 puts the walls in the upper
    // midtones where the damage is readable; 1.45 (tried first) clipped stone and sky to
    // flat white, which is not "brighter", it is less picture.
    this.renderer.toneMappingExposure = 1.2;
    this.canvas = this.renderer.domElement;
    this.canvas.style.display = 'block';
    this.host.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    // Dusk-blue palette so the grass terrain reads as outdoors while staying on the
    // platform's dark theme. The gradient sky dome (vfx.buildSky) replaces the flat
    // clear color; the fog is tuned to the dome's horizon so distance melts into sky.
    // Fog range is tuned to the FORTRESS, not to the old scattered settlement: the outer
    // wall is 116 units across and the keep sits 58 units behind the gate, so the previous
    // 70/230 range dissolved the objective into haze from the moment you could see it.
    // Start the falloff past the far wall and end it past the arena boundary.
    this.scene.fog = new THREE.Fog(0x3d4961, 150, 520);
    const hemi = new THREE.HemisphereLight(0xbfc8dd, 0x2c2e33, 1.6);
    this.scene.add(hemi);
    // Unshadowed interior fill. The keep is a roofed stone box: without this the vault
    // holding the chalice — the place the whole game points at — was lit only by the
    // chalice's own lamp.
    const ambient = new THREE.AmbientLight(0xc8d4e8, 0.7);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff2df, 2.2);
    sun.position.set(40, 80, 25);
    // One 2048 shadow map over the whole arena: ~13 cm texels, chunky but exactly the
    // voxel aesthetic — and cheap enough that collapsing towers cast moving shadows.
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.q.shadowMapSize, this.q.shadowMapSize);
    // The shadow camera FOLLOWS the player (see _updateShadowCamera) instead of covering
    // the whole 260 m arena from a fixed box. Same map resolution over a 70 m window is
    // ~7x finer per texel AND rasterises a fraction of the geometry, because everything
    // outside the window is culled out of the shadow pass entirely.
    sun.shadow.camera.left = -SHADOW_HALF_M;
    sun.shadow.camera.right = SHADOW_HALF_M;
    sun.shadow.camera.top = SHADOW_HALF_M;
    sun.shadow.camera.bottom = -SHADOW_HALF_M;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 280;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    this.scene.add(sun);
    this.scene.add(sun.target);

    this.camera = new THREE.PerspectiveCamera(70, width / height, 0.1, 500);

    this.vfx = new Vfx(this.renderer, this.scene, this.camera, this.host, this.q);
    this.vfx.buildSky();
    // Time-of-day owns the sun and the hemisphere fill from here on: it repaints their
    // colour and intensity every frame, so the literals set above are only the values
    // that hold for the first frame.
    this.sun = sun;
    this.vfx.attachSun(sun, hemi, ambient);
    this.skyEnv = new SkyEnvironment(this.renderer, this.scene, this.q);
    this.skyEnv.update(0, this.vfx.skyKey, this.vfx._sunDir, true);
    this.particles = new ParticleSystem(this.scene, this.q.particles);
    this.particles.setViewportHeight(this.renderer.getSize(new THREE.Vector2()).y);
    this.decals = new DecalField(this.scene, this.q.decals);
    this._spaceClock = 0;
    // Demo (kiosk) keeps the visuals but stays silent — there is no user gesture to
    // unlock an AudioContext, and the catalog page should not hum on its own.
    this.audio = this.demo ? null : new VoxelAudio();
    this.audio?.setQuality(this.q); // before startMusic: it decides the reverb graph
    this.audio?.startMusic();
    this._prevLocked = false;
    this._cueClock = 1.5;
    this._tensionClock = 0;

    // Physics: cannon-es (the platform's physics engine — PoRacer/PoMarbleRace ship it
    // via the same import map).
    // SI units, sweep-and-prune broadphase and the full per-material contact table all
    // come from physics.js — there is one definition of what stone-on-stone means.
    const built2 = createPhysicsWorld();
    this.physicsWorld = built2.world;
    this.physicsMaterials = built2.materials;
    this.physicsAccumulator = 0;

    const { structures, terrain, spawn, chaliceSpot, turretMounts } = buildWorld(
      this.scene, this.physicsWorld, this.volumes, this.seed, this.physicsMaterials);
    this.structures = structures;
    this.terrain = terrain;
    this.spawnPoint = spawn;

    this.shrapnel = new ShrapnelField(this.scene, this.physicsWorld, this.q.shrapnel,
      { terrain: this.terrain, structures: this.structures }, this.physicsMaterials.stone);
    this.debris = new DebrisManager(this.scene, this.physicsWorld, {
      collapse: (voxels, position) => {
        this.audio?.collapse(voxels, position);
        // Shake scales with tonnage and falls off with distance; a truly big fall
        // close by also rings the ears.
        const d = this.player.position.distanceTo(position);
        const proximity = Math.max(0, 1 - d / 50);
        this.vfx.addShake(Math.min(0.5, voxels / 700) * proximity);
        if (voxels > 250 && d < 18) this.audio?.concussion(0.5);
        // Masonry dust: count tracks tonnage so a cornice puffs and a tower billows.
        this.particles.emit(position, Math.min(90, 6 + (voxels >> 2)), {
          color: 0xb9ab95, speed: 1.6, spread: 3, size: 0.9,
          life: 2.6, upward: 0.7,
        });
      },
      impact: (mass, position) => {
        this.audio?.debrisHit(mass, position);
        this.particles.emit(position, Math.min(10, 2 + (mass / 60) | 0), {
          color: 0x9c8f79, speed: 1.1, spread: 1, size: 0.5, life: 1.1, upward: 0.5,
        });
      },
    }, this.physicsMaterials);
    this.debris.structures = this.structures; // blast shielding needs the occluders
    // The structural solve runs in a worker now, so detached mass arrives a frame or two
    // after the shot that caused it rather than as a return value. This is the delivery
    // point; scoring still counts every voxel, just slightly later.
    for (const s of this.structures) {
      s.onClusters = (structure, clusters) => {
        for (const c of clusters) {
          this.voxelsDestroyed += c.voxels.length;
          this.debris.spawnCluster(structure, c);
        }
      };
    }
    this.enemies = new EnemyManager(this.scene, this.structures, this.debris, this.terrain, {
      demo: this.demo,
      onPlayerDamage: (amount) => this._damagePlayer(amount),
      onKill: (type, byCrush) => {
        this.kills++;
        if (type === 'brute') this.bruteKills++;
        if (byCrush) { this.crushKills++; this.audio?.crush(0); }
      },
      onCarve: (removed, clusterVoxels) => { this.voxelsDestroyed += removed + clusterVoxels; },
      fx: {
        spit: (position) => this.audio?.spit(position, 1),
        enemyDeath: (type, position) => {
          this.audio?.enemyDeath(type, position);
          this.particles.emit(position, 14, {
            color: type === 'brute' ? 0x8a6a4a : 0x7dffb0,
            speed: 3.2, spread: 1.2, size: 0.45, life: 0.9, upward: 1.0,
          });
        },
      },
    });
    this.weapon = new Weapon(this.scene, this.camera, this.structures, this.terrain, this.debris,
      this.enemies, (removed, clusterVoxels) => { this.voxelsDestroyed += removed + clusterVoxels; },
      {
        shot: (muzzle) => { this.audio?.shot(); this.vfx.muzzleFlash(muzzle); },
        altLaunch: () => this.audio?.altLaunch(),
        detonate: (point) => {
          const near = Math.max(0, 1 - this.player.position.distanceTo(point) / 55);
          this.audio?.explosion(point, near);
          this.vfx.shockwave(point);
          this.vfx.addShake(0.45);
          this.particles.emit(point, 70, {
            color: 0x6b6157, speed: 7, spread: 2, size: 1.4, life: 2.4, upward: 1.1,
          });
          this.particles.emit(point, 26, {
            color: 0xffb066, speed: 10, spread: 1, size: 0.7, life: 0.5, upward: 1.4,
          });
          this.decals.stamp(point, this._surfaceNormal(point), { radius: 3.4, color: 0x140f0b });
        },
        // Primary-fire contact: a small puff and a small burn, so sustained digging
        // leaves a visible trench rather than a clean hole.
        impact: (point, kind, normal) => {
          this.particles.emit(point, 6, {
            color: kind === 'terrain' ? 0x6d5138 : 0xc9c6c0,
            speed: 2.2, spread: 0.6, size: 0.32, life: 0.8, upward: 0.9,
          });
          this.decals.stamp(point, normal ?? this._surfaceNormal(point),
            { radius: 0.85, color: 0x1c1712, life: 26 });
        },
      },
      this.shrapnel);

    this.player = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.4, 1.0, 4, 12),
      createActorMaterial({ color: 0xe4572e }),
    );
    // Spawn is OUTSIDE the outer wall. The origin is the middle of the keep now, and a
    // player who starts on the objective has not besieged anything.
    this.player.position.copy(this.spawnPoint);
    this._prevPlayerPos = this.player.position.clone();
    this._playerVel = new THREE.Vector3();
    this._buildPlayerBody();
    this.player.castShadow = true;
    this.scene.add(this.player);

    // ── The siege fixtures ──────────────────────────────────────────────
    this.chalice = new Chalice(this.scene, chaliceSpot, this.q);
    this.guns = new FortressGuns(this.scene, this.structures, this.terrain, {
      onPlayerDamage: (amount) => this._damagePlayer(amount),
      fx: {
        fire: (position) => {
          this.audio?.shot();
          this.vfx.muzzleFlash(position);
          this.particles.emit(position, 5, {
            color: 0xffd9a0, speed: 3.4, spread: 0.4, size: 0.35, life: 0.4, upward: 0.6,
          });
        },
        hit: (position) => {
          this.particles.emit(position, 7, {
            color: 0xc9c6c0, speed: 2.6, spread: 0.5, size: 0.3, life: 0.6, upward: 1.0,
          });
          this.decals.stamp(position, this._surfaceNormal(position),
            { radius: 0.6, color: 0x241c14, life: 18 });
        },
        // A gun going quiet is the reward for demolition, so it gets its own beat.
        destroyed: (position) => {
          this.audio?.collapse(180, position);
          this.particles.emit(position, 30, {
            color: 0x8d8478, speed: 4.5, spread: 1.5, size: 0.8, life: 1.8, upward: 1.2,
          });
        },
      },
    });
    for (const mount of turretMounts) this.guns.add(mount.position, mount.structure);

    this._buildVeil();
    this._buildCrosshair();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    document.addEventListener('contextmenu', this._onContextMenu);
    this.canvas.addEventListener('click', this._onClick);

    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(this.host);

    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame((t) => this._frame(t));

    this._notify('OnReady', this.volumes.length, structures.length);
  }

  /** Blazor Resume button (a click gesture, so the lock request is permitted). */
  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.audio?.setPaused(false);
    if (!this.demo) this.canvas.requestPointerLock();
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    document.removeEventListener('contextmenu', this._onContextMenu);
    this.canvas?.removeEventListener('click', this._onClick);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('mouseup', this._onMouseUp);
    this.resizeObserver?.disconnect();
    if (this._locked()) document.exitPointerLock();

    this.audio?.dispose();
    this.vfx?.dispose();
    this.particles?.dispose();
    this.decals?.dispose();
    this.skyEnv?.dispose();
    this.guns?.dispose();
    this.chalice?.dispose();
    this.shrapnel?.dispose();
    this.weapon?.dispose();
    this.enemies?.dispose();
    this.debris?.dispose();
    for (const s of this.structures ?? []) s.dispose();
    this.terrain?.dispose(this.scene, this.physicsWorld);

    // Free GPU resources explicitly — this SPA holds one live GL context per mounted 3D
    // game and Chrome caps the pool (~16), so a leaked context starves sibling games.
    this.scene?.traverse((obj) => {
      obj.geometry?.dispose();
      if (obj.material) (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(m => m.dispose());
    });
    this.renderer?.dispose();
    this.canvas?.remove();
    this.veil?.remove();
    this.crosshair?.remove();
  }

  // ── Frame loop ─────────────────────────────────────────────────────────

  _frame(time) {
    if (!this.running) return;
    // Clamped on BOTH ends: rAF can hand the first callback a timestamp EARLIER than the
    // performance.now() taken in start() (observed ~2.8 s stale in headless Chromium). An
    // unclamped negative dt turns the camera lerp factor 1−e^(−12·dt) negative and the
    // follow diverges exponentially instead of converging.
    const dt = Math.min(Math.max((time - this.lastTime) / 1000, 0), 0.05);
    this.lastTime = time;

    // Paused: render the frozen scene, nothing advances. Dead: the world keeps moving
    // for the kill-cam beat (debris settles, enemies mill), but the clock and input do
    // not.
    const simulating = this.state !== 'paused';
    const playing = this.state === 'playing';

    if (playing) {
      this.elapsed += dt;
      if (this.demo) this._updateDemo(dt);
      else if (this._locked()) this._move(dt);
      // Height is the physics body's business now — the mesh is synced from it after the
      // step. The exponential settle onto terrain.heightAt() that used to live here was
      // what made the player float over craters and up two-metre ledges.
    }

    if (simulating) {
      this.physicsAccumulator = Math.min(this.physicsAccumulator + dt, 0.1);
      while (this.physicsAccumulator >= PHYSICS_STEP) {
        // Swept contacts run BEFORE the step, on the motion the step is about to take.
        this.shrapnel.sweep(PHYSICS_STEP);
        this.physicsWorld.step(PHYSICS_STEP);
        this.physicsAccumulator -= PHYSICS_STEP;
      }
      if (this.playerBody) {
        this.onGround = this._probeGround();
        // Keep the player inside the arena. This is the one hard constraint left on the
        // body: the perimeter wall is terrain and can be dug through, and falling off the
        // edge of the heightfield is not a failure state anyone asked for.
        const b = this.playerBody.position;
        b.x = THREE.MathUtils.clamp(b.x, -ARENA_HALF + 1, ARENA_HALF - 1);
        b.z = THREE.MathUtils.clamp(b.z, -ARENA_HALF + 1, ARENA_HALF - 1);
        this.player.position.set(b.x, b.y - PLAYER_RADIUS + 0.9, b.z);
      }

      this.weapon.update(dt, this._muzzle());
      // Overheat lockout: sound the vent exactly once, on the rising edge.
      if (this.weapon.locked && !this._prevLocked) this.audio?.lockout();
      this._prevLocked = this.weapon.locked;
      this.debris.update(dt);
      if (playing) this.enemies.updateSpawning(
        dt, this.elapsed, this.player.position, this.camera.getWorldDirection(new THREE.Vector3()));
      this.enemies.update(dt, this.player.position);
      this.enemies.checkCrush(this.debris.pieces);
      // Velocity is differenced, not integrated: _move() writes the position directly, so
      // this is the only honest source for the turrets' lead calculation.
      this._playerVel.copy(this.player.position).sub(this._prevPlayerPos)
        .divideScalar(Math.max(dt, 1e-4));
      this._prevPlayerPos.copy(this.player.position);
      this.guns.update(dt, this.player.position, this._playerVel);
      this.chalice.update(dt);
      // Demo runs its own celebrate-and-restart loop (see _updateDemo); ending the run
      // would leave the kiosk sitting on a game-over screen.
      if (playing && !this.demo && this.chalice.reached(this.player.position)) this._claimChalice();
      if (playing) this._checkPlayerCrush(dt);
      // One re-mesh budget shared by the whole fortress. A carve's own chunks always
      // rebuild immediately (a hole must appear on the frame you made it); LOD band
      // changes are lazy and draw from this, so crossing a distance boundary spreads a
      // building's re-mesh over several frames instead of spiking one.
      let remeshBudget = REMESH_CHUNKS_PER_FRAME;
      for (const s of this.structures) {
        s.updateLod(this.camera.position);
        remeshBudget -= s.rebuildDirtyChunks(Math.max(0, remeshBudget));
        s.rebuildCollider(); // no-op unless flagged dirty by a carve
      }
      this.terrain.updateLod(this.camera.position);
      this.terrain.rebuildDirty(Math.max(0, remeshBudget)); // no-op unless a dig landed
      this.terrain.rebuildCollider();
    }

    if (playing && this.audio) this._updateAudioAmbience(dt);

    this._followCamera(dt);
    this.vfx.update(dt);
    this.vfx.applyShake(); // AFTER lookAt so the shake never fights the follow lerp
    this.particles.update(dt);
    this.decals.update(dt);
    this.shrapnel.update(dt);
    this._updateShadowCamera();
    this._streamColliders(dt);
    this._updateRenderScale(dt);
    this.skyEnv.update(dt, this.vfx.skyKey, this.vfx._sunDir);
    if (this.audio) {
      // The listener must follow the SHAKEN camera: the shake is what the player sees,
      // so it is also what the player should hear.
      this.camera.updateMatrixWorld();
      this.audio.setListener(this.camera);
      this._updateSpace(dt);
    }

    this.hudClock -= dt;
    if (this.hudClock <= 0 && this.state !== 'dead') {
      this.hudClock = HUD_INTERVAL_S;
      this._pumpHud();
    }

    // Multiplayer slice (2026-08-18): drift-corrected 50 ms lockstep tick. Drains any
    // accumulated time so a stutter frame doesn't double-ship a batch; an idle frame
    // catches up. The server is the source of truth for the tick number — we ship a
    // monotonic local counter purely so the wrapper knows which tick each batch belongs
    // to if it wants to surface it in dev consoles.
    if (this.mode === 'multi' && this.multiplayerSink) {
      this._lockstepClock += dt * 1000;
      while (this._lockstepClock >= this._lockstepIntervalMs) {
        this._lockstepClock -= this._lockstepIntervalMs;
        this._shipLockstepBatch();
      }
    }

    this.vfx.render();
    this.rafId = requestAnimationFrame((t) => this._frame(t));
  }

  /** Enemy presence cues + music tension, on their own slow clocks. */
  _updateAudioAmbience(dt) {
    this._tensionClock -= dt;
    if (this._tensionClock <= 0) {
      this._tensionClock = 1;
      this.audio.setTension(Math.min(1, this.enemies.count / 16 + this.elapsed / 420));
    }

    this._cueClock -= dt;
    if (this._cueClock > 0 || this.enemies.enemies.length === 0) return;
    this._cueClock = 0.8 + Math.random() * 0.6;
    // One cue per tick, from a random nearby enemy — a crowd murmurs, it doesn't roll-call.
    const pool = this.enemies.enemies;
    const e = pool[(Math.random() * pool.length) | 0];
    const d = e.mesh.position.distanceTo(this.player.position);
    if (d > 50) return;
    this.audio.enemyCue(e.type, this._panFor(e.mesh.position), Math.max(0.1, 1 - d / 50));
  }

  /** Stereo pan (−1..1) of a world position relative to the camera. */
  /**
   * Reverb zone probe. Throttled to 4 Hz: it walks every structure, and the answer only
   * has to beat the 250 ms crossfade in setSpace() to feel instant.
   */
  /**
   * Keep the sun's shadow box centred just ahead of the player. A directional light's
   * shadow camera is an orthographic box: making it cover the arena means every texel is
   * 6-13 cm and every wall in the fortress is rasterised into it every frame. A 90 m box
   * that travels with the player renders a handful of buildings at a much finer texel.
   */
  _updateShadowCamera() {
    if (!this.sun?.castShadow) return;
    const p = this.player.position;
    // Snap to texel-sized steps. Without this the whole shadow map shimmers as the box
    // slides, because every texel lands on different geometry each frame.
    const texel = (SHADOW_HALF_M * 2) / this.q.shadowMapSize;
    const cx = Math.round(p.x / texel) * texel;
    const cz = Math.round(p.z / texel) * texel;
    this.sun.position.set(cx + this.vfx._sunDir.x * 120,
      p.y + this.vfx._sunDir.y * 120, cz + this.vfx._sunDir.z * 120);
    this.sun.target.position.set(cx, p.y, cz);
    this.sun.target.updateMatrixWorld();
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  /**
   * Add and remove static collider bodies by distance. The fortress puts ~7 700 collision
   * shapes in the world; the broadphase sorts and the narrowphase bounding-sphere-tests
   * all of them forever, even the far side of the keep that nothing can reach. Streaming
   * keeps only what is near the player resident. Accuracy is untouched — a body is either
   * fully present or too far away to be touched.
   */
  _streamColliders(dt) {
    this._streamClock = (this._streamClock ?? 0) - dt;
    if (this._streamClock > 0) return;
    this._streamClock = PHYSICS_STREAM_INTERVAL_S;
    const p = this.player.position;
    for (const s of this.structures) {
      const dx = s.group.position.x - p.x;
      const dz = s.group.position.z - p.z;
      // Reach includes the piece's own extent: a 116 m curtain wall is "near" long before
      // its centre is.
      const reach = PHYSICS_STREAM_RADIUS_M + Math.max(s.dims[0], s.dims[2]) * s.scale * 0.5;
      s.setColliderActive(dx * dx + dz * dz <= reach * reach);
    }
  }

  /**
   * Dynamic resolution. Every post-processing pass costs per pixel, so when frames run
   * long the cheapest lever is to render fewer of them and let SMAA clean up the edges.
   * Physics and simulation are untouched — this only changes how many pixels are shaded.
   */
  _updateRenderScale(dt) {
    if (!this.q.dynamicResolution) return;
    this._frameAvg = this._frameAvg === undefined ? dt : this._frameAvg * 0.9 + dt * 0.1;
    this._scaleClock = (this._scaleClock ?? 0) - dt;
    if (this._scaleClock > 0) return;
    this._scaleClock = 0.5;

    const target = 1 / 60;
    let scale = this._renderScale ?? 1;
    if (this._frameAvg > target * 1.35) scale -= 0.1;
    else if (this._frameAvg < target * 1.05) scale += 0.05;
    scale = Math.min(1, Math.max(MIN_RENDER_SCALE, scale));
    if (Math.abs(scale - (this._renderScale ?? 1)) < 0.01) return;
    this._renderScale = scale;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * scale);
    this._resize();
  }

  _updateSpace(dt) {
    this._spaceClock -= dt;
    if (this._spaceClock > 0) return;
    this._spaceClock = 0.25;
    const head = this._headVec ??= new THREE.Vector3();
    head.copy(this.player.position);
    let indoors = 0;
    for (const s of this.structures) {
      // Cheap reject first: outside the building's own radius it cannot enclose anyone.
      const reach = Math.max(s.dims[0], s.dims[2]) * s.scale * 0.75;
      if (head.distanceToSquared(s.group.position) > reach * reach) continue;
      indoors = Math.max(indoors, s.indoorAt(head));
      if (indoors >= 1) break;
    }
    this.audio.setSpace(indoors);
  }

  /**
   * Best-guess surface normal at a contact point, for orienting a decal. Sampling the
   * terrain height on a small cross is exact for the stepped heightfield and good enough
   * on a wall, where the gradient saturates and the mark ends up near-vertical.
   */
  _surfaceNormal(point) {
    const n = this._normVec ??= new THREE.Vector3();
    const e = 0.6;
    const hL = this.terrain.heightAt(point.x - e, point.z);
    const hR = this.terrain.heightAt(point.x + e, point.z);
    const hD = this.terrain.heightAt(point.x, point.z - e);
    const hU = this.terrain.heightAt(point.x, point.z + e);
    return n.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  _panFor(position) {
    const v = this._panVec ??= new THREE.Vector3();
    const right = this._panRight ??= new THREE.Vector3();
    v.copy(position).sub(this.camera.position);
    right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    const len = v.length() || 1;
    return THREE.MathUtils.clamp(v.dot(right) / len, -1, 1);
  }

  _pumpHud() {
    // Crosshair rings track the same snapshot cadence; the CSS transition smooths the
    // 10 Hz steps into a continuous sweep.
    if (this.ringHeat) {
      this.ringHeat.style.setProperty('--p', Math.round(this.weapon.heat * 100));
      this.ringHeat.classList.toggle('pvs-ring-locked', this.weapon.locked);
      const altPct = Math.round((1 - this.weapon.altReadyIn / this.weapon.altCooldownTotal) * 100);
      this.ringAlt.style.setProperty('--p', altPct);
      this.ringAlt.classList.toggle('pvs-ring-ready', altPct >= 100);
    }

    // Flat positional primitives by design — see the interop note at the top.
    this._notify('OnHudTick',
      Math.max(0, Math.round(this.hp)),
      Math.round(this.weapon.heat * 100),
      this.weapon.locked,
      Math.round((1 - this.weapon.altReadyIn / this.weapon.altCooldownTotal) * 100),
      this._score(),
      Math.round(this.elapsed),
      this.kills,
      this.enemies.count,
      this.debris.bodyCount,
      this.debris.particleCount);
  }

  _score() {
    return Math.floor(this.elapsed) * 10 + this.kills * 25 + this.bruteKills * 50
      + this.crushKills * 40 + Math.floor(this.voxelsDestroyed / 20);
  }

  /**
   * The chalice is in hand: the run ends in a win. Deliberately shares the teardown with
   * death (same pointer-lock release, same HUD pump) so there is one end-of-run path and
   * only the notification differs.
   */
  _claimChalice() {
    this.state = 'dead';
    this.won = true;
    this.chalice.group.visible = false;
    this.audio?.explosion(this.chalice.position, 1);
    this.vfx.addShake(0.6);
    this.vfx.shockwave(this.chalice.position);
    this.particles.emit(this.chalice.position, 120, {
      color: 0xffd05a, speed: 8, spread: 1.5, size: 0.7, life: 2.2, upward: 1.6,
    });
    this.weapon.setPrimaryHeld(false);
    if (this._locked()) document.exitPointerLock();
    this._pumpHud();
    this._notify('OnVictory',
      this._score() + VICTORY_BONUS, Math.round(this.elapsed * 10) / 10,
      this.kills, this.bruteKills, this.crushKills, this.voxelsDestroyed,
      this.seed.toString(16).padStart(8, '0'));
  }

  /**
   * Put the player in the physics world.
   *
   * They used to be outside it entirely: position was written directly, the ground was a
   * height lookup with a 2.2 m auto-step, and walls were a hand-rolled probe of five
   * points at three heights. That could not be pushed, buried, knocked down a slope or
   * hit by a falling wall, and it walked up two-metre ledges.
   *
   * Now: a sphere body with rotation locked, driven by setting horizontal velocity while
   * gravity and contacts do the rest. Friction against the world is zero by design (see
   * the contact table in physics.js) so the player never sticks to a wall; braking is
   * done by writing velocity, which is what every responsive FPS controller does.
   */
  _buildPlayerBody() {
    const p = this.player.position;
    this.playerBody = new CANNON.Body({
      mass: PLAYER_MASS,
      shape: new CANNON.Sphere(PLAYER_RADIUS),
      position: new CANNON.Vec3(p.x, p.y + PLAYER_RADIUS, p.z),
      material: this.physicsMaterials.player,
      linearDamping: 0.0,
      angularDamping: 1.0,
      allowSleep: false,
      collisionFilterGroup: PLAYER_GROUP,
      collisionFilterMask: WORLD_GROUP | PLAYER_GROUP,
    });
    this.playerBody.fixedRotation = true;   // no tumbling; the camera owns orientation
    this.playerBody.updateMassProperties();
    this.physicsWorld.addBody(this.playerBody);
    this._groundRay = { from: new CANNON.Vec3(), to: new CANNON.Vec3() };
    this.onGround = false;
  }

  /**
   * Is there world within GROUND_PROBE below the player? Uses the physics world's own
   * raycast, so it sees the terrain heightfield, the fortress colliders AND the rubble —
   * standing on a pile of your own debris counts as standing on something.
   */
  _probeGround() {
    if (!this.playerBody) return false;
    const b = this.playerBody.position;
    this._groundRay.from.set(b.x, b.y, b.z);
    this._groundRay.to.set(b.x, b.y - GROUND_PROBE, b.z);
    const result = this._rayResult ??= new CANNON.RaycastResult();
    result.reset();
    // The ray starts at the body's own centre, so without a filter it can hit the player
    // sphere first and report "airborne" while standing still. Filtering by group is the
    // fix; treating a self-hit as not-grounded (the first attempt) meant the step assist
    // never ran and ground movement permanently used the sluggish in-air control factor.
    this.physicsWorld.raycastClosest(this._groundRay.from, this._groundRay.to,
      { skipBackfaces: true, collisionFilterMask: WORLD_GROUP }, result);
    return result.hasHit;
  }

  _damagePlayer(amount) {
    if (this.demo || this.state !== 'playing') return;
    this.hp -= amount;
    this.audio?.playerHit();
    this.vfx.flashDamage(Math.min(0.7, 0.2 + amount / 30));
    this.vfx.addShake(Math.min(0.5, amount / 45));
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = 'dead';
      this.audio?.death();
      this.vfx.addShake(0.8);
      this.weapon.setPrimaryHeld(false);
      if (this._locked()) document.exitPointerLock();
      this._pumpHud();
      this._notify('OnGameOver',
        this._score(), Math.round(this.elapsed * 10) / 10,
        this.kills, this.bruteKills, this.crushKills, this.voxelsDestroyed,
        this.seed.toString(16).padStart(8, '0'));
    }
  }

  /** The debris is impartial (PRD §F5) — the player half of the crush check. */
  _checkPlayerCrush(dt) {
    for (const piece of this.debris.pieces) {
      if (piece.frozen) continue;
      if (piece.crushCd > 0) { piece.crushCd -= dt; continue; }
      const speed = piece.body.velocity.length();
      if (speed < PLAYER_CRUSH_MIN_SPEED) continue;
      const reach = Math.max(piece.dims[0], piece.dims[1], piece.dims[2]) * piece.scale * 0.5;
      const d = this.player.position.distanceTo(
        new THREE.Vector3(piece.body.position.x, piece.body.position.y, piece.body.position.z));
      if (d < reach + 0.7) {
        piece.crushCd = 0.6;
        this.audio?.crush(0);
        // Momentum, rescaled for REAL masses. The old coefficient was tuned when debris
        // weighed 1% of what it should, so once physics.js fixed the units every pebble
        // hit the 50-damage cap and a single collapse was instant death. Now a 300 kg
        // chunk at 8 m/s does about 29, and a falling tower section still kills you.
        const momentum = piece.body.mass * speed;   // kg m/s
        this._damagePlayer(Math.min(60, Math.max(2, momentum * 0.012)));
      }
    }
  }

  _muzzle() {
    return new THREE.Vector3(
      this.player.position.x, this.player.position.y + 0.7, this.player.position.z);
  }

  // ── Demo autopilot (kiosk attract mode, PRD platform convention) ───────
  // Wanders the arena, picks something nearby — an enemy, a building, or a patch of
  // ground — and digs/shoots at it in bursts, with the occasional blast ball. Shots aim
  // through weapon.aimOverride since the kiosk has no mouse.

  /**
   * Kiosk siege AI.
   *
   * The demo used to amble to random points and shoot whatever happened to be nearby,
   * which showed off the destruction but not the GAME. It now plays the actual objective:
   * march on the keep, blast a way through whatever stands between it and the chalice,
   * and go inside. Losing does not apply — when it reaches the prize it celebrates and
   * starts a fresh assault, so the attract loop never ends on a dead screen.
   *
   * There is no pathfinding, deliberately. The bot walks the straight line to the chalice
   * and treats anything on that line as a wall to be removed, because that IS the game:
   * the fortress has no route in that does not go through masonry. When it stops making
   * progress it sidesteps, and if that fails too it blasts the obstruction.
   */
  _updateDemo(dt) {
    const st = this.demoState ??= {
      phase: 'advance',       // 'advance' | 'breach' | 'triumph'
      aim: null,
      burstT: 1.2, firing: false, altT: 2,
      strafe: 0, strafeT: 0,
      stuckT: 0, lastX: 0, lastZ: 0, progressT: 0,
      triumphT: 0,
    };
    const p = this.player.position;
    const goal = this.chalice.position;

    if (st.phase === 'triumph') {
      // Stand in the vault for a beat, then re-arm and walk back out to do it again.
      st.triumphT -= dt;
      this.weapon.setPrimaryHeld(false);
      this.weapon.aimOverride = null;
      if (st.triumphT <= 0) this._restartDemoSiege();
      return;
    }

    // ── Where am I going, and what is in the way? ──────────────────────────
    const toGoal = this._demoVec ??= new THREE.Vector3();
    toGoal.set(goal.x - p.x, 0, goal.z - p.z);
    const distance = toGoal.length();
    if (distance > 0.001) toGoal.divideScalar(distance);

    // Probe straight ahead at chest height. Whatever it hits first is the obstacle; if it
    // hits nothing within the probe, the way is clear and the bot just walks.
    const muzzle = this._muzzle();
    const eye = this._demoEye ??= new THREE.Vector3();
    eye.copy(muzzle);
    const obstacle = this._demoObstacle(eye, toGoal, DEMO_PROBE_RANGE);

    // ── Aim ───────────────────────────────────────────────────────────────
    // At the obstruction when there is one, otherwise at the chalice itself, which keeps
    // the camera pointed at the objective and makes the attract loop legible.
    //
    // `forced` is the backstop for the case the rays cannot see: if the bot has stopped
    // gaining ground it digs straight ahead regardless of what the probe thinks. Progress
    // is the ground truth here, not the raycast.
    const forced = st.stuckT >= 1 && !obstacle;
    if (forced) {
      const ahead = this._demoForce ??= new THREE.Vector3();
      ahead.copy(toGoal).multiplyScalar(DEMO_FORCE_DISTANCE).add(eye);
      st.aim = ahead;
    } else {
      st.aim = obstacle ? obstacle.point : goal;
    }
    st.phase = (obstacle || forced) ? 'breach' : 'advance';

    const toA = this._demoAim ??= new THREE.Vector3();
    toA.subVectors(st.aim, muzzle);
    const targetYaw = Math.atan2(-toA.x, -toA.z);
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    this.yaw += dy * Math.min(1, 5 * dt);
    this.player.rotation.y = this.yaw;
    this.weapon.aimOverride = { origin: muzzle, direction: toA.clone().normalize() };

    // ── Move ──────────────────────────────────────────────────────────────
    // Advance while the way is clear, and while breaching keep pressing forward so the
    // bot walks through the hole the instant it opens. A slow oscillating sidestep stops
    // it grinding a corner forever.
    st.strafeT -= dt;
    if (st.strafeT <= 0) {
      st.strafeT = 1.6 + Math.random() * 1.4;
      st.strafe = (Math.random() * 2 - 1) * 0.55;
    }
    const speed = st.phase === 'breach' ? WALK_SPEED * 0.35 : WALK_SPEED * 0.8;
    const wishX = (toGoal.x + -toGoal.z * st.strafe) * speed;
    const wishZ = (toGoal.z + toGoal.x * st.strafe) * speed;
    const v = this.playerBody.velocity;
    const control = this.onGround ? 1 : 0.18;
    v.x += (wishX - v.x) * control;
    v.z += (wishZ - v.z) * control;
    this._stepUp(wishX, wishZ);

    // ── Stuck detection ───────────────────────────────────────────────────
    // Measured over a second of real movement, not per frame: a bot pressed against a
    // wall it is actively demolishing is not stuck, it is working.
    st.progressT += dt;
    if (st.progressT >= 1) {
      const moved = Math.hypot(p.x - st.lastX, p.z - st.lastZ);
      st.lastX = p.x; st.lastZ = p.z;
      st.progressT = 0;
      st.stuckT = moved < 1.2 ? st.stuckT + 1 : 0;
      if (st.stuckT === 1) st.altT = 0;   // first stalled second: blast now, not in four
      if (st.stuckT >= 3) {
        // Three seconds without ground gained: sidestep as well, in case the bot is
        // grinding a corner that digging straight ahead will never clear.
        st.strafe = (Math.random() < 0.5 ? -1 : 1) * 0.9;
        st.strafeT = 2.5;
      }
    }

    // ── Fire ──────────────────────────────────────────────────────────────
    // Dig continuously while breaching, in bursts otherwise. The blast ball goes on a
    // cooldown and is spent on whatever is blocking the path -- never on open air, which
    // is what the old random-target version did most of the time.
    st.burstT -= dt;
    if (st.burstT <= 0) {
      st.firing = !st.firing;
      st.burstT = st.firing ? 1.4 + Math.random() : 0.5 + Math.random() * 0.8;
    }
    this.weapon.setPrimaryHeld(st.phase === 'breach' ? true : st.firing);
    st.altT -= dt;
    const worthBlasting = (obstacle && obstacle.distance < DEMO_BLAST_RANGE) || forced;
    if (st.altT <= 0 && worthBlasting) {
      st.altT = DEMO_BLAST_COOLDOWN_S;
      this.weapon.fireAlt(muzzle);
    }

    // ── Win ───────────────────────────────────────────────────────────────
    if (distance < DEMO_REACH_RADIUS && Math.abs(p.y - goal.y) < 6) {
      st.phase = 'triumph';
      st.triumphT = DEMO_TRIUMPH_S;
      this.weapon.setPrimaryHeld(false);
      this.audio?.explosion(goal, 1);
      this.vfx.addShake(0.6);
      this.vfx.shockwave(goal);
      this.particles.emit(goal, 140, {
        color: 0xffd05a, speed: 9, spread: 1.6, size: 0.75, life: 2.4, upward: 1.7,
      });
    }
  }

  /**
   * First structure surface on the ray, or null. Only structures are probed: terrain in
   * the way is a slope the bot walks up, not something it needs to shoot through, and
   * treating every hillside as an obstruction had it digging craters in the approach
   * instead of getting on with the assault.
   */
  _demoObstacle(origin, direction, range) {
    // THREE rays, not one: chest, knee and head. A single chest-height ray threads a
    // doorway or an arrow slit and reports "clear" while the bot's body is hard against
    // the jamb beside it — which is exactly how it spent 85 seconds parked 10 m from the
    // chalice with a clear line of sight to it.
    const probe = this._demoProbe ??= new THREE.Vector3();
    let best = null;
    for (const dy of [0, -0.9, 0.7]) {
      probe.set(origin.x, origin.y + dy, origin.z);
      for (const s of this.structures) {
        const hit = s.raycast(probe, direction, range);
        if (hit && (!best || hit.distance < best.distance)) best = hit;
      }
    }
    return best;
  }

  /** Reset the attract loop: chalice back on its plinth, bot back outside the walls. */
  _restartDemoSiege() {
    this.chalice.taken = false;
    this.chalice.group.visible = true;
    const s = this.spawnPoint;
    this.playerBody.position.set(s.x, s.y + PLAYER_RADIUS, s.z);
    this.playerBody.velocity.set(0, 0, 0);
    this.demoState.phase = 'advance';
    this.demoState.stuckT = 0;
    this.demoState.progressT = 0;
    this.demoState.lastX = s.x;
    this.demoState.lastZ = s.z;
  }

  _move(dt) {
    let fwd = 0, strafe = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) fwd += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) fwd -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafe += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafe -= 1;
    if (fwd === 0 && strafe === 0) return;

    const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? RUN_SPEED : WALK_SPEED;
    const len = Math.hypot(fwd, strafe);
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // Move in the camera's ground frame: forward is where the camera looks on XZ.
    const wishX = (fwd * -sin + strafe * cos) / len * speed;
    const wishZ = (fwd * -cos + strafe * -sin) / len * speed;

    // Horizontal velocity is COMMANDED, vertical is left to gravity and contacts. That
    // split is what keeps the controls crisp while still letting the world push back:
    // walls stop you because the solver says so, not because a probe vetoed the move.
    const v = this.playerBody.velocity;
    // In the air the player keeps most of their momentum — you cannot turn on a sixpence
    // mid-fall — while on the ground the command wins outright.
    const control = this.onGround ? 1 : 0.18;
    v.x += (wishX - v.x) * control;
    v.z += (wishZ - v.z) * control;
    this._stepUp(wishX, wishZ);
    this.player.rotation.y = this.yaw;
  }

  /**
   * Step assist. A sphere resting on the ground cannot climb a sharp 0.4 m voxel ledge —
   * it just presses into the face — so a short forward probe at ankle height looks for a
   * step whose top is within STEP_HEIGHT and lifts the body onto it. Anything taller is a
   * wall, and a wall is supposed to stop you: that is the entire premise of the siege.
   */
  _stepUp(wishX, wishZ) {
    if (!this.onGround) return;
    const speed = Math.hypot(wishX, wishZ);
    if (speed < 0.1) return;
    const b = this.playerBody.position;
    const ahead = this._stepVec ??= new THREE.Vector3();
    ahead.set(wishX / speed, 0, wishZ / speed).multiplyScalar(PLAYER_RADIUS + 0.25);

    const footY = b.y - PLAYER_RADIUS;
    const ground = this.terrain.heightAt(b.x + ahead.x, b.z + ahead.z);
    const rise = ground - footY;
    if (rise > 0.02 && rise <= STEP_HEIGHT) {
      this.playerBody.position.y = ground + PLAYER_RADIUS + 0.02;
      if (this.playerBody.velocity.y < 0) this.playerBody.velocity.y = 0;
    }
  }


  /**
   * Settled debris is solid scenery: a frozen (or resting) chunk of a collapsed
   * building blocks the player like any wall. Moving debris stays passable — the crush
   * check is what punishes standing under it — and pebbles too small to read as an
   * obstacle are ignored.
   */

  _look(mx, my) {
    if (!this._locked()) return;
    this.yaw -= mx * 0.0025;
    this.pitch = THREE.MathUtils.clamp(this.pitch - my * 0.0025, -1.2, 0.5);
  }

  _mouseButton(e, down) {
    if (!this._locked() || this.state !== 'playing') return;
    if (e.button === 0) this.weapon.setPrimaryHeld(down);
    if (e.button === 2 && down) this.weapon.fireAlt(this._muzzle());
  }

  _followCamera(dt) {
    const eyeY = this.player.position.y + 0.7;
    const target = new THREE.Vector3(
      this.player.position.x + CAM_DISTANCE * Math.sin(this.yaw) * Math.cos(this.pitch),
      eyeY + CAM_DISTANCE * -Math.sin(this.pitch),
      this.player.position.z + CAM_DISTANCE * Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    // Exponential smoothing, framerate-independent.
    const k = 1 - Math.exp(-12 * dt);
    this.camera.position.lerp(target, k);
    // Never let the chase camera sink into a hillside behind the player.
    const camFloor = this.terrain.heightAt(this.camera.position.x, this.camera.position.z) + 0.8;
    if (this.camera.position.y < camFloor) this.camera.position.y = camFloor;
    this.camera.lookAt(this.player.position.x, eyeY, this.player.position.z);
  }

  _resize() {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.vfx?.resize(width, height);
    this.particles?.setViewportHeight(height * Math.min(window.devicePixelRatio, 2));
  }

  // ── Pointer lock ───────────────────────────────────────────────────────

  _locked() { return document.pointerLockElement === this.canvas; }

  _lockChanged() {
    if (this.disposed) return;
    const locked = this._locked();
    this.crosshair.style.display = locked ? 'block' : 'none';
    if (locked) {
      this.everLocked = true;
      this.veil.style.display = 'none';
      document.addEventListener('mousemove', this._onMouseMove);
      document.addEventListener('mousedown', this._onMouseDown);
      document.addEventListener('mouseup', this._onMouseUp);
      // The Blazor state machine learns "actually playing" only from here — pointer
      // lock is the moment control transfers, both on first click and after Resume.
      if (!this.demo && this.state === 'playing') this._notify('OnResumed');
      return;
    }
    this.weapon.setPrimaryHeld(false);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('mouseup', this._onMouseUp);
    // Lock loss during play ALWAYS pauses (PRD §F9) — the player is never killed while
    // unable to steer. Blazor owns the pause overlay; the engine veil stays for the
    // never-locked-yet state only.
    if (this.state === 'playing' && this.everLocked && !this.demo) {
      this.state = 'paused';
      this.audio?.setPaused(true);
      this._notify('OnPaused', 'pointerlock');
    }
  }

  /** Click-to-play veil over the canvas before the first pointer lock of a run. */
  _buildVeil() {
    this.veil = document.createElement('div');
    this.veil.className = 'pvs-veil';
    this.veil.innerHTML =
      '<div class="pvs-veil-card"><strong>Click to play</strong>' +
      '<span>WASD move · trackpad/mouse look · <b>F</b> dig · <b>G</b> blast (mouse buttons work too) · Esc pause</span></div>';
    this.veil.addEventListener('click', () => this.canvas.requestPointerLock());
    if (this.demo) this.veil.style.display = 'none';
    this.host.appendChild(this.veil);
  }

  _buildCrosshair() {
    this.crosshair = document.createElement('div');
    this.crosshair.className = 'pvs-crosshair';
    this.crosshair.style.display = 'none';
    // Glanceable state around the reticle: inner ring = weapon heat, outer = blast
    // cooldown. Conic-gradient fills driven by --p (0..100) from _pumpHud.
    this.crosshair.innerHTML =
      '<div class="pvs-ring pvs-ring-heat" style="--p: 0"></div>' +
      '<div class="pvs-ring pvs-ring-alt" style="--p: 100"></div>';
    this.ringHeat = this.crosshair.querySelector('.pvs-ring-heat');
    this.ringAlt = this.crosshair.querySelector('.pvs-ring-alt');
    this.host.appendChild(this.crosshair);
  }

  _notify(method, ...args) {
    try { this.dotnetRef.invokeMethodAsync(method, ...args); }
    catch (err) { console.warn(`[PoVoxelStrike] ${method} interop failed:`, err); }
  }
}
