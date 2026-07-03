// voxelshooter.js — Voxel Disintegrator entry point for PoMiniGames.
// Pulls in the small modules from ./voxelshooter/* and wires them into the
// orchestrator class (`VoxelGame`). The public window.VoxelShooterGame
// surface stays identical so the Blazor page (VoxelShooterPage.razor) does
// not need to change.
//
// Features added in this revision:
//   1. Power-up drops — defeated enemies have a chance to drop rotating
//      pickups (rapid fire, spread shot, shield, nuke, health) with timed
//      or instant effects.
//   2. Wave-based survival — menu now offers Endless or Waves; clearing
//      each wave opens a spendable shop between battles.
//   3. Destructible voxel terrain — pre-placed cover obstacles around the
//      playfield; missed shots carve permanent holes that reveal new
//      sightlines or give the player dug-in cover.

import * as THREE from 'three';
import { VoxelEnemy } from './voxelshooter/enemy.js';
import { VoxelTerrain } from './voxelshooter/terrain.js';
import { PowerUp, POWERUP_TYPES, rollType } from './voxelshooter/powerups.js';
import { WaveSystem } from './voxelshooter/waves.js';
import { makeRng } from './voxelshooter/rng.js';
import { sfx, setMuted } from './voxelshooter/audio.js';

(function () {
  'use strict';

  let _activeGame = null;

  window.VoxelShooterGame = {
    init(containerId, dotnetHelper) {
      if (_activeGame) { _activeGame.dispose(); _activeGame = null; }
      const el = document.getElementById(containerId);
      if (!el) { console.error('[VoxelShooter] container not found:', containerId); return; }
      _activeGame = new VoxelGame(el, dotnetHelper);
      _activeGame.start();
    },
    destroy() {
      if (_activeGame) { _activeGame.dispose(); _activeGame = null; }
    },
    // Exposed for the host (Blazor) to toggle sound from a settings menu.
    setMuted(muted) { setMuted(muted); },
  };

  // ─── Tunables ──────────────────────────────────────────────────────────
  const GAME_DURATION_S = 100;
  const PLAYER_MAX_HP = 3;
  const PLAYER_IFRAME_S = 1.2;
  const PICKUP_RANGE = 1.6;
  const ENEMY_SPEED_BASE = 10;
  const MOVE_SPEED = 30;
  const PLAYFIELD_RADIUS = 80;
  const POWERUP_DROP_CHANCE = 0.18;
  const POWERUP_DROP_CHANCE_BONUS = 0.08;

  // ─── Style tokens (kept consistent with original buttons) ──────────────
  const BTN_PRIMARY       = 'background:#00D9FF;color:#000;border:none;padding:12px 32px;font-size:1rem;cursor:pointer;letter-spacing:2px;font-weight:bold;font-family:monospace';
  const BTN_GREEN         = 'background:#4ade80;color:#000;border:none;padding:12px 32px;font-size:.95rem;cursor:pointer;font-weight:bold;font-family:monospace';
  const BTN_RED           = 'background:#FF3366;color:#fff;border:none;padding:12px 32px;font-size:.95rem;cursor:pointer;font-weight:bold;font-family:monospace';
  const BTN_OUTLINE_CYAN  = 'background:transparent;color:#00D9FF;border:1px solid #00D9FF;padding:12px 28px;cursor:pointer;font-family:monospace';
  const BTN_OUTLINE_GREEN = 'background:transparent;color:#4ade80;border:1px solid #4ade80;padding:12px 28px;cursor:pointer;font-family:monospace';
  const BTN_OUTLINE_RED   = 'background:transparent;color:#FF3366;border:1px solid #FF3366;padding:12px 28px;cursor:pointer;font-family:monospace';

  // ─── helpers ──────────────────────────────────────────────────────────
  function _el(tag, styles) {
    const el = document.createElement(tag);
    Object.assign(el.style, styles);
    return el;
  }

  // ─── VoxelGame ────────────────────────────────────────────────────────
  class VoxelGame {
    constructor(container, dotnet) {
      this.container = container;
      this.dotnet = dotnet;
      this.disposed = false;
      this.mode = 'menu';

      this.enemiesDestroyed = 0;
      this.score = 0;
      this.endlessDuration = GAME_DURATION_S;
      this.endlessStartTime = 0;
      this.totalPausedMs = 0;
      this.lastSpawnTimeMs = 0;
      this.waveSpawnSpeed = ENEMY_SPEED_BASE;

      this.playerHp = PLAYER_MAX_HP;
      this.playerMaxHp = PLAYER_MAX_HP;
      this.bonusDamage = 0;
      this.shieldCharges = 0;
      this.buffs = [];
      this._lastShotAt = 0;
      this._lastPlayerHitAt = 0;
      this._now = () => performance.now() / 1000;

      this.enemies = [];
      this.powerUps = [];
      this.particles = [];
      this.tracers = [];
      this.rng = makeRng((Date.now() ^ 0x9E3779B9) >>> 0);
      this.terrain = null;

      this.scene = null;
      this.camera = null;
      this.renderer = null;
      this.raycaster = null;

      this.playerPos = new THREE.Vector3(0, 1.6, 0);
      this.yaw = 0;
      this.pitch = 0;
      this.input = { w: false, s: false, a: false, d: false };
      this.isLocked = false;

      this.hud = null;
      this.overlay = null;
      this.hudBar = null;
      this.timerEl = null;
      this.killsEl = null;
      this.msgEl = null;
      this.hpEl = null;
      this.buffEl = null;
      this.waveEl = null;
      this.creditsEl = null;
      this.crosshair = null;

      this.waves = null;
      this._modeAtWin = 'endless';

      this._buildScene();
      this._buildHUD();
      this._bindInput();
      this.terrain = new VoxelTerrain(this.scene, this.rng);
      this.terrain.generateInitialLayout();
      this._showMenu();
    }

    // ── Scene ────────────────────────────────────────────────────────────
    _buildScene() {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.setClearColor(0x050510);
      this.container.style.position = 'relative';
      this.container.style.overflow = 'hidden';
      this.container.appendChild(this.renderer.domElement);
      this.renderer.domElement.style.display = 'block';
      this._resize();

      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.Fog(0x050510, 80, 450);

      this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
      this.camera.position.copy(this.playerPos);
      this.scene.add(this.camera);

      this.scene.add(new THREE.AmbientLight(0x112244, 1.0));
      const sun = new THREE.DirectionalLight(0xffffff, 1.5);
      sun.position.set(60, 120, 60);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 600;
      ['left', 'right', 'top', 'bottom'].forEach(s => {
        sun.shadow.camera[s] = s.includes('l') || s.includes('b') ? -250 : 250;
      });
      this.scene.add(sun);

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(600, 600),
        new THREE.MeshStandardMaterial({ color: 0x030308, roughness: 1 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      this.scene.add(floor);
      this.scene.add(new THREE.GridHelper(600, 60, 0x00d9ff, 0x001833));

      this.raycaster = new THREE.Raycaster();
    }

    _resize() {
      const w = this.container.clientWidth  || 800;
      const h = this.container.clientHeight || 500;
      this.renderer.setSize(w, h);
      if (this.camera) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    }

    // ── HUD ──────────────────────────────────────────────────────────────
    _buildHUD() {
      this.hud = document.createElement('div');
      Object.assign(this.hud.style, {
        position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
        pointerEvents: 'none', fontFamily: 'monospace', zIndex: '10',
      });
      this.container.appendChild(this.hud);

      this.crosshair = _el('div', {
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%,-50%)', display: 'none',
      });
      this.crosshair.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24">
          <line x1="12" y1="2"  x2="12" y2="22" stroke="#00D9FF" stroke-width="1"/>
          <line x1="2"  y1="12" x2="22" y2="12" stroke="#00D9FF" stroke-width="1"/>
          <circle cx="12" cy="12" r="2" stroke="#00D9FF" fill="none" stroke-width="1.5"/>
        </svg>`;
      this.hud.appendChild(this.crosshair);

      this.hudBar = _el('div', {
        position: 'absolute', top: '0', left: '0', right: '0',
        background: 'rgba(0,5,20,0.85)', borderBottom: '1px solid #00D9FF33',
        padding: '6px 16px', display: 'none',
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        fontSize: '13px', color: '#00D9FF', gap: '12px',
      });
      this.timerEl   = document.createElement('span');
      this.msgEl     = document.createElement('span');
      this.killsEl   = document.createElement('span');
      this.hpEl      = document.createElement('span');
      this.waveEl    = document.createElement('span');
      this.creditsEl = document.createElement('span');
      this.buffEl    = document.createElement('span');
      [this.waveEl, this.timerEl, this.hpEl, this.killsEl, this.msgEl, this.creditsEl, this.buffEl]
        .forEach(n => this.hudBar.appendChild(n));
      this.hud.appendChild(this.hudBar);

      this.overlay = _el('div', {
        position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,5,20,0.9)', pointerEvents: 'all', zIndex: '20',
      });
      this.hud.appendChild(this.overlay);
    }

    // ── Menu / pause / win / lose ────────────────────────────────────────
    _showMenu() {
      this.mode = 'menu';
      this.overlay.style.display = 'flex';
      const muted = window.__voxMuted === true;
      this.overlay.innerHTML = `
        <div style="text-align:center;color:#00D9FF;max-width:480px;padding:24px">
          <h1 style="font-size:2rem;letter-spacing:4px;margin:0 0 8px">VOXEL DISINTEGRATOR</h1>
          <p style="color:#aaa;margin:0 0 4px">Shoot voxel cubes. Survive the night. Pop power-ups.</p>
          <p style="color:#555;font-size:11px;margin:0 0 18px">
            WASD · Move &nbsp;|&nbsp; Mouse · Aim &nbsp;|&nbsp; Click · Shoot &nbsp;|&nbsp; L · Mouse-look &nbsp;|&nbsp; ESC · Pause &nbsp;|&nbsp; 1–4 · Quality
          </p>
          <div style="display:flex;flex-direction:column;gap:8px;align-items:center">
            <button id="_vsStartEndless" style="${BTN_PRIMARY}">▶ ENDLESS · Survive ${GAME_DURATION_S}s</button>
            <button id="_vsStartWaves"   style="${BTN_PRIMARY}">🌊 WAVES · 10-wave campaign</button>
            <button id="_vsToggleMute"    style="${BTN_OUTLINE_CYAN}">${muted ? '🔇 Sound: Off' : '🔊 Sound: On'}</button>
          </div>
          <p style="color:#444;font-size:11px;margin:18px 0 0">Pick-ups: ⚡ Rapid · ✦ Spread · 🛡 Shield · ☢ Nuke · ❤ Health</p>
        </div>`;
      this.overlay.querySelector('#_vsStartEndless').onclick = () => this._startGame('endless');
      this.overlay.querySelector('#_vsStartWaves').onclick   = () => this._startGame('waves');
      this.overlay.querySelector('#_vsToggleMute').onclick    = () => {
        const next = !window.__voxMuted;
        window.__voxMuted = next;
        setMuted(next);
        this._showMenu();  // re-render so label flips
      };
    }

    _showPause() {
      this.overlay.style.display = 'flex';
      this.overlay.innerHTML = `
        <div style="text-align:center;color:#00D9FF">
          <h2 style="letter-spacing:4px;margin:0 0 8px">⏸ PAUSED</h2>
          <p style="color:#aaa;font-size:12px;margin:0 0 20px">Press ESC to resume</p>
          <button id="_vsResume" style="${BTN_PRIMARY}">▶ RESUME</button>
          <button id="_vsMenu"   style="${BTN_OUTLINE_CYAN};margin-left:8px">🏠 MENU</button>
        </div>`;
      this.overlay.querySelector('#_vsResume').onclick = () => this._resume();
      this.overlay.querySelector('#_vsMenu').onclick   = () => this._resetToMenu();
    }

    _showWin(reason) {
      document.exitPointerLock();
      this.crosshair.style.display = 'none';
      this.overlay.style.display   = 'flex';
      this.overlay.innerHTML = `
        <div style="text-align:center;color:#4ade80;max-width:420px;padding:24px">
          <h1 style="font-size:2rem;letter-spacing:4px;margin:0 0 8px">🎉 ${reason || 'YOU WIN!'}</h1>
          <p style="color:#aaa;margin:0 0 4px">SURVIVAL COMPLETE!</p>
          <p style="margin:4px 0 20px">Enemies Eliminated: <strong style="color:#4ade80">${this.enemiesDestroyed}</strong></p>
          <button id="_vsAgain" style="${BTN_GREEN}">▶ PLAY AGAIN</button>
          <button id="_vsMenu2" style="${BTN_OUTLINE_GREEN};margin-left:8px">🏠 MENU</button>
        </div>`;
      this.overlay.querySelector('#_vsAgain').onclick = () => { this._clearGame(); this._startGame(this._modeAtWin || 'endless'); };
      this.overlay.querySelector('#_vsMenu2').onclick = () => this._resetToMenu();
      if (this.dotnet) this.dotnet.invokeMethodAsync('OnGameResult', true, this.enemiesDestroyed).catch(() => {});
    }

    _showLose(reason) {
      document.exitPointerLock();
      this.crosshair.style.display = 'none';
      this.overlay.style.display   = 'flex';
      this.overlay.innerHTML = `
        <div style="text-align:center;color:#FF3366;max-width:420px;padding:24px">
          <h1 style="font-size:2rem;letter-spacing:4px;margin:0 0 8px">💥 GAME OVER</h1>
          <p style="color:#aaa;margin:0 0 4px">${reason}</p>
          <p style="margin:4px 0 20px">Enemies Eliminated: <strong style="color:#FF3366">${this.enemiesDestroyed}</strong></p>
          <button id="_vsAgain2" style="${BTN_RED}">▶ PLAY AGAIN</button>
          <button id="_vsMenu3" style="${BTN_OUTLINE_RED};margin-left:8px">🏠 MENU</button>
        </div>`;
      this.overlay.querySelector('#_vsAgain2').onclick = () => { this._clearGame(); this._startGame(this._modeAtWin || 'endless'); };
      this.overlay.querySelector('#_vsMenu3').onclick  = () => this._resetToMenu();
      if (this.dotnet) this.dotnet.invokeMethodAsync('OnGameResult', false, this.enemiesDestroyed).catch(() => {});
    }

    _resetToMenu() {
      this._clearGame();
      this.hudBar.style.display = 'none';
      this.crosshair.style.display = 'none';
      this._showMenu();
    }

    _clearGame() {
      this.enemies.forEach(e => e.dispose(this.scene));
      this.enemies = [];
      this.powerUps.forEach(p => p.dispose());
      this.powerUps = [];
      this.particles.forEach(p => {
        this.scene.remove(p.pts); p.pts.geometry.dispose(); p.pts.material.dispose();
      });
      this.particles = [];
      this.tracers.forEach(t => { this.scene.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); });
      this.tracers = [];
      this.terrain.reset();
      this.terrain.generateInitialLayout();
      this.playerPos.set(0, 1.6, 0);
      this.yaw = 0; this.pitch = 0;
      this.buffs = [];
      this.shieldCharges = 0;
      this.playerHp = PLAYER_MAX_HP;
      this.playerMaxHp = PLAYER_MAX_HP;
      this.bonusDamage = 0;
      if (this.waves) { this.waves.abort(); this.waves = null; }
      this.waveSpawnSpeed = ENEMY_SPEED_BASE;
    }

    // ── Game flow ────────────────────────────────────────────────────────
    _startGame(mode = 'endless') {
      this.mode = mode;
      this._modeAtWin = mode;
      this.score = 0;
      this.enemiesDestroyed = 0;
      this.endlessStartTime = performance.now();
      this.totalPausedMs = 0;
      this.lastSpawnTimeMs = 0;
      this.waveSpawnSpeed = ENEMY_SPEED_BASE;

      this.enemies.forEach(e => e.dispose(this.scene));
      this.enemies = [];
      this.powerUps.forEach(p => p.dispose());
      this.powerUps = [];

      if (mode === 'waves') {
        this.waves = new WaveSystem(this.overlay, {
          onEnemySpawn:    () => this._spawnWaveEnemy(),
          onSetSpeedFloor: (s) => { this.waveSpawnSpeed = s; },
          onNuke:          () => this._doNuke(),
          onShopPurchase:  (eff) => this._applyShopEffects(eff),
          onEndGame:       (win, kills) => {
            this._modeAtWin = mode;
            if (win) this._showWin('VICTORY');
            else    this._showLose('DEFEATED');
          },
        });
        this.waves.start();
      }

      this.overlay.style.display = 'none';
      this.hudBar.style.display  = 'flex';
      this.crosshair.style.display = 'block';
    }

    _pause() {
      if (this.mode !== 'endless' && this.mode !== 'waves') return;
      const wasPlaying = this.mode;
      this.mode = 'paused';
      this._pausedFromMode = wasPlaying;
      if (this.waves && this.waves.shopOpen) return;
      document.exitPointerLock();
      this.crosshair.style.display = 'none';
      this._showPause();
    }

    _resume() {
      if (this.mode !== 'paused') return;
      this.mode = this._pausedFromMode || 'endless';
      this.overlay.style.display = 'none';
      this.crosshair.style.display = 'block';
    }

    _toggleLock() {
      if (this.isLocked) { try { document.exitPointerLock(); } catch (e) { /* ignore */ } }
      else this._requestLock();
    }

    _requestLock() {
      try {
        const el = this.renderer.domElement;
        const p = el.requestPointerLock ? el.requestPointerLock() : null;
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) { /* pointer lock unavailable */ }
    }

    // ── Input ────────────────────────────────────────────────────────────
    _bindInput() {
      this._kd = e => {
        if (e.code === 'KeyW') this.input.w = true;
        if (e.code === 'KeyS') this.input.s = true;
        if (e.code === 'KeyA') this.input.a = true;
        if (e.code === 'KeyD') this.input.d = true;

        if (e.code === 'Escape') {
          if (this.waves && this.waves.shopOpen) return;
          if (this.mode === 'endless' || this.mode === 'waves') this._pause();
          else if (this.mode === 'paused') this._resume();
          return;
        }
        if (this.waves && this.waves.handleKey(e.code)) return;

        if (e.code === 'KeyL' && (this.mode === 'endless' || this.mode === 'waves')) this._toggleLock();
        if (e.key === '4') this.renderer.setPixelRatio(Math.min(window.devicePixelRatio * 1.5, 3));
        if (e.key === '3') this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        if (e.key === '2') this.renderer.setPixelRatio(1);
        if (e.key === '1') this.renderer.setPixelRatio(0.75);
      };
      this._ku = e => {
        if (e.code === 'KeyW') this.input.w = false;
        if (e.code === 'KeyS') this.input.s = false;
        if (e.code === 'KeyA') this.input.a = false;
        if (e.code === 'KeyD') this.input.d = false;
      };
      this._mm = e => {
        if (this.mode !== 'endless' && this.mode !== 'waves') return;
        if (this.isLocked) {
          this.yaw   -= e.movementX * 0.002;
          this.pitch -= e.movementY * 0.002;
        } else {
          const rect = this.renderer.domElement.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const nx = (e.clientX - rect.left) / rect.width  - 0.5;
          const ny = (e.clientY - rect.top)  / rect.height - 0.5;
          this.yaw   = -nx * 2.2;
          this.pitch = -ny * 1.6;
        }
        this.pitch = Math.max(-1.1, Math.min(1.1, this.pitch));
      };
      this._click = () => {
        if (this.mode !== 'endless' && this.mode !== 'waves') return;
        const now = this._now();
        const cooldown = this._buffActive('rapid_fire') ? 0.08 : 0.18;
        if (now - this._lastShotAt < cooldown) return;
        this._lastShotAt = now;
        this._shoot();
      };
      this._plc = () => { this.isLocked = document.pointerLockElement === this.renderer.domElement; };
      this._rsz = () => this._resize();
      window.addEventListener('keydown', this._kd);
      window.addEventListener('keyup', this._ku);
      window.addEventListener('mousemove', this._mm);
      this.renderer.domElement.addEventListener('click', this._click);
      document.addEventListener('pointerlockchange', this._plc);
      window.addEventListener('resize', this._rsz);
    }

    // ── Buff / shield helpers ────────────────────────────────────────────
    _buffActive(typeId) {
      const t = this._now();
      return this.buffs.some(b => b.typeId === typeId && b.expiresAt > t);
    }

    _addBuff(typeId, durationS) {
      const t = this._now() + durationS;
      const existing = this.buffs.find(b => b.typeId === typeId && b.expiresAt > t);
      if (existing) existing.expiresAt = t;
      else this.buffs.push({ typeId, expiresAt: t });
      if (typeId === 'shield') this.shieldCharges = Math.max(this.shieldCharges, 1);
    }

    _tickBuffs() {
      const t = this._now();
      this.buffs = this.buffs.filter(b => b.expiresAt > t);
      if (this.shieldCharges > 0 && !this._buffActive('shield')) this.shieldCharges = 0;
    }

    _renderBuffsHud() {
      if (!this.buffEl) return;
      const chips = this.buffs
        .map(b => {
          const def = Object.values(POWERUP_TYPES).find(p => p.id === b.typeId);
          if (!def) return '';
          const remaining = Math.max(0, b.expiresAt - this._now());
          const color = '#' + def.color.toString(16).padStart(6, '0');
          return `<span style="color:${color};margin-left:6px">${def.icon} ${remaining.toFixed(1)}s</span>`;
        })
        .filter(Boolean)
        .join('');
      this.buffEl.innerHTML = chips;
    }

    _renderHpHud() {
      if (!this.hpEl) return;
      const hearts = [];
      for (let i = 0; i < this.playerMaxHp; i++) {
        if (i < this.playerHp) hearts.push('<span style="color:#FF3366">❤</span>');
        else hearts.push('<span style="color:#333">♡</span>');
      }
      this.hpEl.innerHTML = `HP ${hearts.join('')}`;
    }

    _renderWaveHud() {
      if (!this.waveEl) return;
      if (this.mode === 'waves' && this.waves && this.waves.gameActive) {
        this.waveEl.style.display = '';
        this.waveEl.innerHTML = `🌊 Wave ${this.waves.wave}/${this.waves.maxWave}`;
        if (this.creditsEl) {
          this.creditsEl.style.display = '';
          this.creditsEl.innerHTML = `💰 ${this.waves.currency}`;
        }
      } else {
        this.waveEl.style.display = 'none';
        if (this.creditsEl) this.creditsEl.style.display = 'none';
      }
    }

    // ── Shooting ─────────────────────────────────────────────────────────
    _shoot() {
      sfx.shoot();
      this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera);
      const dir = this.raycaster.ray.direction.clone();
      const muzzle = this.camera.position.clone().addScaledVector(dir, 1.2);

      const terrainHit = this.terrain.raycast(this.raycaster);
      const enemyMeshes = this.enemies.map(e => e.mesh);
      const enemyHits = enemyMeshes.length ? this.raycaster.intersectObjects(enemyMeshes, false) : [];
      const enemyHit = enemyHits.length ? enemyHits[0] : null;

      let closest = null;
      if (terrainHit && enemyHit) {
        closest = terrainHit.distance <= enemyHit.distance ? terrainHit : enemyHit;
      } else {
        closest = terrainHit || enemyHit;
      }
      const endPoint = closest
        ? closest.point.clone()
        : this.camera.position.clone().addScaledVector(dir, 400);

      this._fireTracer(muzzle, endPoint);

      if (!closest) return;

      if (closest === terrainHit) {
        const removed = this.terrain.carve(closest.point, 1.6 + this.bonusDamage * 0.3);
        if (removed > 0) {
          this._spawnParticles(closest.point, Math.min(removed, 60), 0x999999);
          sfx.terrainHit();
          if (this.waves) this.waves.notifyTerrainCarved(removed);
        }
        return;
      }

      const enemyIdx = this.enemies.findIndex(e => e.mesh === closest.object);
      if (enemyIdx < 0) return;
      const enemy = this.enemies[enemyIdx];
      const destroyed = enemy.applyDamage(closest.point, 4.0 + this.bonusDamage);
      this.score += destroyed;
      this._spawnParticles(closest.point, destroyed, 0xff7700);
      if (destroyed > 0) sfx.enemyHit();
      if (enemy.health <= 0) {
        enemy.dispose(this.scene);
        this.enemies.splice(enemyIdx, 1);
        this.enemiesDestroyed++;
        sfx.enemyKill();
        const dropChance = POWERUP_DROP_CHANCE + (this.shieldCharges > 0 ? POWERUP_DROP_CHANCE_BONUS : 0);
        if (this.rng.next() < dropChance) {
          this._spawnPowerUp(enemy.group.position);
        }
        if (this.waves) this.waves.notifyEnemyKilled();
      }
    }

    _fireTracer(from, to) {
      const geo  = new THREE.BufferGeometry().setFromPoints([from, to]);
      const mat  = new THREE.LineBasicMaterial({ color: 0xffff44, transparent: true, opacity: 1.0, depthWrite: false });
      const line = new THREE.Line(geo, mat);
      this.scene.add(line);
      this.tracers.push({ line, life: 0.12 });
    }

    _tickTracers(dt) {
      for (let i = this.tracers.length - 1; i >= 0; i--) {
        const t = this.tracers[i];
        t.life -= dt;
        if (t.life <= 0) {
          this.scene.remove(t.line);
          t.line.geometry.dispose();
          t.line.material.dispose();
          this.tracers.splice(i, 1);
        } else {
          t.line.material.opacity = t.life / 0.12;
        }
      }
    }

    // ── Particles ────────────────────────────────────────────────────────
    _spawnParticles(pos, count, color = 0xff7700) {
      const n = Math.min(count * 2 + 10, 60);
      const geo = new THREE.BufferGeometry();
      const arr = new Float32Array(n * 3);
      const vel = [];
      for (let i = 0; i < n; i++) {
        arr[i*3]   = pos.x;
        arr[i*3+1] = pos.y;
        arr[i*3+2] = pos.z;
        vel.push(new THREE.Vector3(
          (Math.random() - 0.5) * 22, Math.random() * 18 + 4, (Math.random() - 0.5) * 22,
        ));
      }
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const mat = new THREE.PointsMaterial({ color, size: 0.6, sizeAttenuation: true, transparent: true });
      const pts = new THREE.Points(geo, mat);
      this.scene.add(pts);
      this.particles.push({ pts, vel, life: 1.0 });
    }

    _tickParticles(dt) {
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.life -= dt * 1.6;
        if (p.life <= 0) {
          this.scene.remove(p.pts);
          p.pts.geometry.dispose();
          p.pts.material.dispose();
          this.particles.splice(i, 1);
          continue;
        }
        const arr = p.pts.geometry.attributes.position.array;
        for (let j = 0; j < p.vel.length; j++) {
          p.vel[j].y -= 9.8 * dt;
          arr[j*3]   += p.vel[j].x * dt;
          arr[j*3+1] += p.vel[j].y * dt;
          arr[j*3+2] += p.vel[j].z * dt;
        }
        p.pts.geometry.attributes.position.needsUpdate = true;
        p.pts.material.opacity = Math.max(0, p.life);
      }
    }

    // ── Power-ups ────────────────────────────────────────────────────────
    _spawnPowerUp(pos) {
      const offset = new THREE.Vector3(this.rng.range(-0.8, 0.8), 0, this.rng.range(-0.8, 0.8));
      const dropPos = pos.clone().add(offset);
      dropPos.y = 1.4;
      const type = rollType(this.rng);
      this.powerUps.push(new PowerUp(this.scene, dropPos, type));
    }

    _tickPowerUps(dt) {
      for (let i = this.powerUps.length - 1; i >= 0; i--) {
        const p = this.powerUps[i];
        if (!p.tick(dt)) {
          p.dispose();
          this.powerUps.splice(i, 1);
        }
      }
      for (let i = this.powerUps.length - 1; i >= 0; i--) {
        const p = this.powerUps[i];
        if (p.mesh.position.distanceTo(this.playerPos) <= PICKUP_RANGE) {
          this._applyPowerUp(p.type);
          sfx.powerUp();
          this._showToast(p.type.onPick, p.type.color);
          p.dispose();
          this.powerUps.splice(i, 1);
        }
      }
    }

    _applyPowerUp(type) {
      if (type.id === 'nuke') {
        const killed = this._doNuke();
        this.score += killed * 20;
        sfx.nuke();
        this._showToast(`☢ ${killed} destroyed`, type.color);
        return;
      }
      if (type.id === 'health') {
        this.playerHp = Math.min(this.playerMaxHp, this.playerHp + 1);
        return;
      }
      if (type.id === 'shield') {
        this.shieldCharges = Math.max(1, this.shieldCharges + 1);
      }
      this._addBuff(type.id, type.duration);
    }

    _applyShopEffects(eff) {
      if (eff.heal) this.playerHp = Math.min(this.playerMaxHp + 1, this.playerHp + eff.heal);
      if (eff.bonusDamage) this.bonusDamage = eff.bonusDamage;
      if (eff.addBuff) {
        const def = Object.values(POWERUP_TYPES).find(p => p.id === eff.addBuff);
        if (def) {
          this._addBuff(def.id, def.duration);
          sfx.shopBuy();
        }
      }
      if (eff.nuke) {
        const killed = this._doNuke();
        this.score += killed * 20;
        sfx.nuke();
      }
    }

    _doNuke() {
      let killed = 0;
      for (const e of this.enemies) {
        e.dispose(this.scene);
        killed++;
      }
      this.enemies = [];
      this.enemiesDestroyed += killed;
      return killed;
    }

    _showToast(text, colorHex) {
      const color = '#' + colorHex.toString(16).padStart(6, '0');
      this.msgEl.innerHTML = `<span style="color:${color};font-weight:bold">${text}</span>`;
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { if (this.msgEl) this.msgEl.textContent = ''; }, 1400);
    }

    // ── Player & enemies ────────────────────────────────────────────────
    _tickPlayer(dt) {
      const fwd   = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3( Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const vel   = new THREE.Vector3();
      if (this.input.w) vel.add(fwd);
      if (this.input.s) vel.sub(fwd);
      if (this.input.a) vel.sub(right);
      if (this.input.d) vel.add(right);
      if (vel.lengthSq() > 0) vel.normalize().multiplyScalar(MOVE_SPEED * dt);
      const desired = this.playerPos.clone().add(vel);
      desired.x = Math.max(-PLAYFIELD_RADIUS, Math.min(PLAYFIELD_RADIUS, desired.x));
      desired.z = Math.max(-PLAYFIELD_RADIUS, Math.min(PLAYFIELD_RADIUS, desired.z));
      const clamped = this.terrain.clampMove(this.playerPos, desired, 0.45);
      this.playerPos.copy(clamped);
      this.playerPos.y = 1.6;
      this.camera.position.copy(this.playerPos);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;
    }

    _spawnRandomEnemy(radius = 220) {
      const ang = this.rng.next() * Math.PI * 2;
      const r   = radius + this.rng.range(0, 60);
      this.enemies.push(new VoxelEnemy(
        this.scene,
        Math.cos(ang) * r,
        this.rng.range(0.6, 1.4),
        Math.sin(ang) * r,
        Math.floor(this.rng.next() * 8),
        this.rng,
      ));
    }

    _spawnWaveEnemy() {
      this._spawnRandomEnemy(this.rng.range(140, 200));
    }

    _takePlayerDamage(enemy) {
      const now = this._now();
      if (this._lastPlayerHitAt && now - this._lastPlayerHitAt < PLAYER_IFRAME_S) return;
      this._lastPlayerHitAt = now;
      if (this.shieldCharges > 0) {
        this.shieldCharges--;
        sfx.shieldBlock();
        this._showToast('🛡 Blocked', 0x00D9FF);
        this._spawnParticles(enemy.group.position, 24, 0x00D9FF);
        return;
      }
      this.playerHp--;
      sfx.playerHurt();
      this._spawnParticles(this.playerPos, 30, 0xFF3366);
      if (this.playerHp <= 0) {
        if (this.waves) { this.waves.onPlayerDefeated(); }
        this.mode = 'lose';
        this._showLose('ELIMINATED');
        return;
      }
      this._renderHpHud();
    }

    // ── Main loop ────────────────────────────────────────────────────────
    start() {
      this._lastT = performance.now();
      const loop = (t) => {
        if (this.disposed) return;
        this._raf = requestAnimationFrame(loop);
        const dt = Math.min((t - this._lastT) / 1000, 0.05);
        this._lastT = t;

        const playing = this.mode === 'endless' || this.mode === 'waves';
        if (playing) {
          this._tickPlayer(dt);
          this._tickBuffs();
          this._tickPowerUps(dt);

          if (this.mode === 'endless') {
            const now = performance.now();
            if (!this.lastSpawnTimeMs || now - this.lastSpawnTimeMs > 2400) {
              this._spawnRandomEnemy();
              this.lastSpawnTimeMs = now;
              const elapsedS = (now - this.endlessStartTime - this.totalPausedMs) / 1000;
              this.waveSpawnSpeed = ENEMY_SPEED_BASE + elapsedS * 0.06;
            }
          } else if (this.mode === 'waves' && this.waves) {
            if (!this.waves.shopOpen) this.waves.tickSpawn(dt);
          }

          for (let i = this.enemies.length - 1; i >= 0; i--) {
            const e = this.enemies[i];
            e.moveToward(this.playerPos, this.waveSpawnSpeed, dt);
            const d = e.group.position.distanceTo(this.playerPos);
            if (d < 1.0) {
              e.dispose(this.scene);
              this.enemies.splice(i, 1);
              continue;
            }
            if (d < 2.2) {
              this._takePlayerDamage(e);
              if (this.mode === 'lose') return;
            }
          }

          this._tickParticles(dt);
          this._tickTracers(dt);

          if (this.mode === 'endless') {
            const elapsedS = Math.floor((performance.now() - this.endlessStartTime - this.totalPausedMs) / 1000);
            const remaining = this.endlessDuration - elapsedS;
            this.timerEl.textContent = `⏱ ${elapsedS}s / ${this.endlessDuration}s`;
            this.killsEl.textContent = `🎯 KILLS: ${this.enemiesDestroyed}`;
            if (remaining <= 15 && !this.msgEl.textContent.startsWith('🎯')) {
              this.msgEl.textContent = `⚠ ${remaining}s!`;
            } else if (remaining > 15 && !this._toastTimer) {
              this.msgEl.textContent = '';
            }
            if (remaining <= 0) {
              this.mode = 'win';
              this._showWin();
              return;
            }
          } else if (this.mode === 'waves' && this.waves && !this.waves.shopOpen) {
            this.timerEl.textContent = `⬣ Spawning`;
            this.killsEl.textContent = `🎯 KILLS: ${this.enemiesDestroyed}`;
          }
          this._renderHpHud();
          this._renderBuffsHud();
          this._renderWaveHud();
        }

        this.renderer.render(this.scene, this.camera);
      };
      this._raf = requestAnimationFrame(loop);
    }

    // ── Teardown ─────────────────────────────────────────────────────────
    dispose() {
      this.disposed = true;
      if (this._raf) cancelAnimationFrame(this._raf);
      window.removeEventListener('keydown', this._kd);
      window.removeEventListener('keyup', this._ku);
      window.removeEventListener('mousemove', this._mm);
      window.removeEventListener('resize', this._rsz);
      document.removeEventListener('pointerlockchange', this._plc);
      document.exitPointerLock();
      this._clearGame();
      if (this.terrain && this.terrain.mesh) {
        this.scene.remove(this.terrain.mesh);
        this.terrain.mesh.geometry.dispose();
        this.terrain.mesh.material.dispose();
      }
      if (this.renderer) { this.renderer.dispose(); this.renderer.domElement.remove(); }
      if (this.hud) this.hud.remove();
    }
  }
})();
