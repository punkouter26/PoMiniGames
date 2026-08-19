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

const EYE_HEIGHT = 1.6;
const CAM_DISTANCE = 7;
const WALK_SPEED = 9;
const RUN_SPEED = 16;
const PHYSICS_STEP = 1 / 60;
const HUD_INTERVAL_S = 0.1;
const PLAYER_MAX_HP = 100;
const PLAYER_CRUSH_MIN_SPEED = 5;

export class Engine {
  constructor(host, dotnetRef, demo, volumes) {
    this.host = host;
    this.dotnetRef = dotnetRef;
    this.demo = demo;
    this.volumes = volumes;

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

  start() {
    const width = this.host.clientWidth || 800;
    const height = this.host.clientHeight || 480;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.style.display = 'block';
    this.host.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    // Dusk-blue palette so the grass terrain reads as outdoors while staying on the
    // platform's dark theme. The gradient sky dome (vfx.buildSky) replaces the flat
    // clear color; the fog is tuned to the dome's horizon so distance melts into sky.
    this.scene.fog = new THREE.Fog(0x3d4961, 70, 230);
    this.scene.add(new THREE.HemisphereLight(0xbfc8dd, 0x2c2e33, 1.6));
    const sun = new THREE.DirectionalLight(0xfff2df, 2.2);
    sun.position.set(40, 80, 25);
    // One 2048 shadow map over the whole arena: ~13 cm texels, chunky but exactly the
    // voxel aesthetic — and cheap enough that collapsing towers cast moving shadows.
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -130;
    sun.shadow.camera.right = 130;
    sun.shadow.camera.top = 130;
    sun.shadow.camera.bottom = -130;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 280;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    this.scene.add(sun);
    this.scene.add(sun.target);

    this.camera = new THREE.PerspectiveCamera(70, width / height, 0.1, 500);

    this.vfx = new Vfx(this.renderer, this.scene, this.camera, this.host);
    this.vfx.buildSky();
    // Demo (kiosk) keeps the visuals but stays silent — there is no user gesture to
    // unlock an AudioContext, and the catalog page should not hum on its own.
    this.audio = this.demo ? null : new VoxelAudio();
    this.audio?.startMusic();
    this._prevLocked = false;
    this._cueClock = 1.5;
    this._tensionClock = 0;

    // Physics: cannon-es (the platform's physics engine — PoRacer/PoMarbleRace ship it
    // via the same import map).
    this.physicsWorld = new CANNON.World({ gravity: new CANNON.Vec3(0, -20, 0) });
    this.physicsWorld.allowSleep = true;
    this.physicsAccumulator = 0;

    const { structures, terrain } = buildWorld(
      this.scene, this.physicsWorld, this.volumes, this.seed);
    this.structures = structures;
    this.terrain = terrain;

    this.debris = new DebrisManager(this.scene, this.physicsWorld, {
      collapse: (voxels, position) => {
        this.audio?.collapse(voxels, this._panFor(position));
        // Shake scales with tonnage and falls off with distance; a truly big fall
        // close by also rings the ears.
        const d = this.player.position.distanceTo(position);
        const proximity = Math.max(0, 1 - d / 50);
        this.vfx.addShake(Math.min(0.5, voxels / 700) * proximity);
        if (voxels > 250 && d < 18) this.audio?.concussion(0.5);
      },
      impact: (mass, position) => {
        this.audio?.debrisHit(mass, this._panFor(position));
      },
    });
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
        spit: (position) => this.audio?.spit(this._panFor(position),
          Math.max(0.2, 1 - this.player.position.distanceTo(position) / 45)),
        enemyDeath: (type, position) => this.audio?.enemyDeath(type, this._panFor(position)),
      },
    });
    this.weapon = new Weapon(this.scene, this.camera, this.structures, this.terrain, this.debris,
      this.enemies, (removed, clusterVoxels) => { this.voxelsDestroyed += removed + clusterVoxels; },
      {
        shot: (muzzle) => { this.audio?.shot(); this.vfx.muzzleFlash(muzzle); },
        altLaunch: () => this.audio?.altLaunch(),
        detonate: (point) => {
          this.audio?.explosion(this._panFor(point));
          this.vfx.shockwave(point);
          this.vfx.addShake(0.45);
        },
      });

    this.player = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.4, 1.0, 4, 12),
      new THREE.MeshLambertMaterial({ color: 0xe4572e }),
    );
    this.player.position.set(0, this.terrain.heightAt(0, 0) + 0.9, 0);
    this.player.castShadow = true;
    this.scene.add(this.player);

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
      // Follow the block terrain: quick exponential settle onto the stepped surface, so
      // walking up a block reads as Minecraft's auto-step rather than a teleport.
      const groundY = this.terrain.heightAt(this.player.position.x, this.player.position.z) + 0.9;
      this.player.position.y += (groundY - this.player.position.y) * Math.min(1, 14 * dt);
    }

    if (simulating) {
      this.physicsAccumulator = Math.min(this.physicsAccumulator + dt, 0.1);
      while (this.physicsAccumulator >= PHYSICS_STEP) {
        this.physicsWorld.step(PHYSICS_STEP);
        this.physicsAccumulator -= PHYSICS_STEP;
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
      if (playing) this._checkPlayerCrush(dt);
      for (const s of this.structures) {
        s.rebuildDirtyChunks();
        s.rebuildCollider(); // no-op unless flagged dirty by a carve
      }
      this.terrain.rebuildDirty();     // both no-ops unless a dig landed this frame
      this.terrain.rebuildCollider();
    }

    if (playing && this.audio) this._updateAudioAmbience(dt);

    this._followCamera(dt);
    this.vfx.update(dt);
    this.vfx.applyShake(); // AFTER lookAt so the shake never fights the follow lerp

    this.hudClock -= dt;
    if (this.hudClock <= 0 && this.state !== 'dead') {
      this.hudClock = HUD_INTERVAL_S;
      this._pumpHud();
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
        this._damagePlayer(Math.min(50, Math.max(6, piece.body.mass * speed * 0.015)));
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

  _updateDemo(dt) {
    const st = this.demoState ??= {
      wander: null, wanderT: 0, aim: null, aimT: 0, burstT: 1.5, firing: false, altT: 4,
    };
    const p = this.player.position;

    // Wander: amble toward a random point; re-roll when reached or stale.
    st.wanderT -= dt;
    if (!st.wander || st.wanderT <= 0 || Math.hypot(st.wander.x - p.x, st.wander.z - p.z) < 3) {
      st.wander = new THREE.Vector3((Math.random() * 2 - 1) * 60, 0, (Math.random() * 2 - 1) * 60);
      st.wanderT = 6 + Math.random() * 5;
    }
    const toW = new THREE.Vector3(st.wander.x - p.x, 0, st.wander.z - p.z);
    if (toW.lengthSq() > 1) {
      toW.normalize();
      const step = WALK_SPEED * 0.7 * dt;
      const tryX = THREE.MathUtils.clamp(p.x + toW.x * step, -ARENA_HALF, ARENA_HALF);
      const tryZ = THREE.MathUtils.clamp(p.z + toW.z * step, -ARENA_HALF, ARENA_HALF);
      if (!this._blockedAt(tryX, tryZ)) { p.x = tryX; p.z = tryZ; }
      else st.wanderT = 0; // walked into a wall — pick somewhere else next frame
    }

    // Aim: re-pick a target every few seconds — enemies first, else a building or dirt.
    st.aimT -= dt;
    if (st.aimT <= 0) {
      st.aimT = 2 + Math.random() * 2.5;
      st.aim = this._pickDemoTarget();
    }

    if (st.aim) {
      // Face it (camera follows yaw), and hand the weapon the exact firing ray.
      const toA = new THREE.Vector3().subVectors(st.aim, this._muzzle());
      const targetYaw = Math.atan2(-toA.x, -toA.z);
      let d = targetYaw - this.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.yaw += d * Math.min(1, 6 * dt);
      this.player.rotation.y = this.yaw;
      this.weapon.aimOverride = { origin: this._muzzle(), direction: toA.normalize() };
    } else {
      this.weapon.aimOverride = null;
    }

    // Fire in bursts; lob a blast ball now and then.
    st.burstT -= dt;
    if (st.burstT <= 0) {
      st.firing = !st.firing;
      st.burstT = st.firing ? 1 + Math.random() * 1.2 : 0.6 + Math.random() * 1.2;
    }
    this.weapon.setPrimaryHeld(st.firing && st.aim !== null);
    st.altT -= dt;
    if (st.altT <= 0 && st.aim) {
      st.altT = 5 + Math.random() * 4;
      this.weapon.fireAlt(this._muzzle());
    }
  }

  _pickDemoTarget() {
    const p = this.player.position;
    // Nearest enemy wins when one is close enough to be interesting.
    let nearest = null, nearestD = 55;
    for (const e of this.enemies.enemies) {
      const d = e.mesh.position.distanceTo(p);
      if (d < nearestD) { nearest = e; nearestD = d; }
    }
    if (nearest && Math.random() < 0.6) return nearest.mesh.position.clone();

    // Otherwise a building mid-section, or a patch of ground to dig.
    if (this.structures.length > 0 && Math.random() < 0.6) {
      const s = this.structures[Math.floor(Math.random() * this.structures.length)];
      return new THREE.Vector3(
        s.group.position.x, s.group.position.y + s.dims[1] * s.scale * (0.2 + Math.random() * 0.5),
        s.group.position.z);
    }
    const a = Math.random() * Math.PI * 2;
    const r = 8 + Math.random() * 14;
    const gx = THREE.MathUtils.clamp(p.x + Math.cos(a) * r, -ARENA_HALF, ARENA_HALF);
    const gz = THREE.MathUtils.clamp(p.z + Math.sin(a) * r, -ARENA_HALF, ARENA_HALF);
    return new THREE.Vector3(gx, this.terrain.heightAt(gx, gz) + 0.2, gz);
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
    const dx = (fwd * -sin + strafe * cos) / len * speed * dt;
    const dz = (fwd * -cos + strafe * -sin) / len * speed * dt;

    // Voxel walls and cliff faces stop the player (axis-separated so walls slide).
    const tryX = THREE.MathUtils.clamp(this.player.position.x + dx, -ARENA_HALF, ARENA_HALF);
    const tryZ = THREE.MathUtils.clamp(this.player.position.z + dz, -ARENA_HALF, ARENA_HALF);
    if (!this._blockedAt(tryX, tryZ)) {
      this.player.position.x = tryX; this.player.position.z = tryZ;
    } else if (!this._blockedAt(tryX, this.player.position.z)) {
      this.player.position.x = tryX;
    } else if (!this._blockedAt(this.player.position.x, tryZ)) {
      this.player.position.z = tryZ;
    }
    this.player.rotation.y = this.yaw;
  }

  _blockedAt(x, z) {
    // Auto-step height (the follow lerp climbs it); anything taller is a cliff wall.
    const groundHere = this.terrain.heightAt(this.player.position.x, this.player.position.z);
    if (this.terrain.heightAt(x, z) - groundHere > 2.2) return true;
    const ground = this.terrain.heightAt(x, z);

    // Capsule-aware probing: the player has a 0.4 radius, so testing only the centre
    // point let the shoulders clip through walls. Probe the centre + four rim points,
    // each at shin/waist/head height, against every structure's voxel grid.
    const probe = this._probeVec ??= new THREE.Vector3();
    for (const [ox, oz] of [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]]) {
      for (const h of [0.5, 1.1, 1.7]) {
        probe.set(x + ox, ground + h, z + oz);
        for (const s of this.structures) {
          if (s.solidAtWorld(probe)) return true;
        }
      }
    }

    return this._blockedByDebris(x, z, ground);
  }

  /**
   * Settled debris is solid scenery: a frozen (or resting) chunk of a collapsed
   * building blocks the player like any wall. Moving debris stays passable — the crush
   * check is what punishes standing under it — and pebbles too small to read as an
   * obstacle are ignored.
   */
  _blockedByDebris(x, z, ground) {
    const torsoY = ground + 0.9;
    const v = this._debrisVec ??= new THREE.Vector3();
    const q = this._debrisQuat ??= new THREE.Quaternion();
    for (const piece of this.debris.pieces) {
      if (piece.voxels < 30) continue;
      if (!piece.frozen && piece.body.velocity.lengthSquared() > 0.5) continue; // cannon Vec3, not THREE

      // Cheap sphere reject before the exact oriented-box test.
      const b = piece.body.position;
      const reach = Math.max(piece.dims[0], piece.dims[1], piece.dims[2]) * piece.scale * 0.87 + 1;
      const dx = x - b.x, dy = torsoY - b.y, dz = z - b.z;
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;

      // Player torso point into the piece's local frame → axis-aligned box test.
      q.set(piece.body.quaternion.x, piece.body.quaternion.y, piece.body.quaternion.z, piece.body.quaternion.w);
      v.set(dx, dy, dz).applyQuaternion(q.conjugate());
      if (Math.abs(v.x) <= piece.dims[0] * piece.scale / 2 + 0.4
        && Math.abs(v.y) <= piece.dims[1] * piece.scale / 2 + 0.9
        && Math.abs(v.z) <= piece.dims[2] * piece.scale / 2 + 0.4) {
        return true;
      }
    }
    return false;
  }

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
