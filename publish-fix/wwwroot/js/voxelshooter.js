// voxelshooter.js — Voxel Disintegrator game for PoMiniGames
// Uses Three.js (loaded via importmap: "three") + Blazor JS interop
import * as THREE from 'three';

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
    }
  };

  // ─── VoxelGame ────────────────────────────────────────────────────────────
  class VoxelGame {
    constructor(container, dotnet) {
      this.container = container;
      this.dotnet = dotnet;          // DotNetObjectReference (may be null)
      this.disposed = false;
      this.state = 'menu';           // menu | playing | paused | win | lose
      this.enemiesDestroyed = 0;
      this.score = 0;
      this.GAME_DURATION = 100;      // seconds to survive
      this.SPAWN_INTERVAL = 3000;    // ms between enemy spawns
      this.lastSpawnTime = 0;
      this.startTime = 0;
      this.pauseTime = 0;
      this.totalPausedMs = 0;
      this.enemies = [];
      this.particles = [];
      this.ENEMY_SPEED = 10;

      // Player
      this.playerPos = new THREE.Vector3(0, 1, 0);
      this.yaw   = 0;
      this.pitch = 0;
      this.input = { w: false, s: false, a: false, d: false };
      this.isLocked = false;
      this.MOVE_SPEED = 30;

      this._buildScene();
      this._buildHUD();
      this._bindInput();
      this._showMenu();
    }

    // ── Scene ──────────────────────────────────────────────────────────────
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

      // Lights
      this.scene.add(new THREE.AmbientLight(0x112244, 1.0));
      const sun = new THREE.DirectionalLight(0xffffff, 1.5);
      sun.position.set(60, 120, 60);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 600;
      ['left','right','top','bottom'].forEach(s => sun.shadow.camera[s] = s.includes('l') || s.includes('b') ? -250 : 250);
      this.scene.add(sun);

      // Floor
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(600, 600),
        new THREE.MeshStandardMaterial({ color: 0x030308, roughness: 1 })
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

    // ── HUD ────────────────────────────────────────────────────────────────
    _buildHUD() {
      this.hud = document.createElement('div');
      Object.assign(this.hud.style, {
        position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
        pointerEvents: 'none', fontFamily: 'monospace', zIndex: '10'
      });
      this.container.appendChild(this.hud);

      // Crosshair
      this.crosshair = _el('div', {
        position:'absolute', top:'50%', left:'50%',
        transform:'translate(-50%,-50%)', display:'none'
      });
      this.crosshair.innerHTML =
        `<svg width="24" height="24" viewBox="0 0 24 24">
           <line x1="12" y1="2"  x2="12" y2="22" stroke="#00D9FF" stroke-width="1"/>
           <line x1="2"  y1="12" x2="22" y2="12" stroke="#00D9FF" stroke-width="1"/>
           <circle cx="12" cy="12" r="2" stroke="#00D9FF" fill="none" stroke-width="1.5"/>
         </svg>`;
      this.hud.appendChild(this.crosshair);

      // Top status bar
      this.hudBar = _el('div', {
        position:'absolute', top:'0', left:'0', right:'0',
        background:'rgba(0,5,20,0.85)', borderBottom:'1px solid #00D9FF33',
        padding:'6px 16px', display:'none',
        flexDirection:'row', justifyContent:'space-between', alignItems:'center',
        fontSize:'13px', color:'#00D9FF'
      });
      this.timerEl   = document.createElement('span');
      this.msgEl     = document.createElement('span');
      this.killsEl   = document.createElement('span');
      this.hudBar.appendChild(this.timerEl);
      this.hudBar.appendChild(this.msgEl);
      this.hudBar.appendChild(this.killsEl);
      this.hud.appendChild(this.hudBar);

      // Fullscreen overlay (menu / pause / end)
      this.overlay = _el('div', {
        position:'absolute', top:'0', left:'0', right:'0', bottom:'0',
        display:'flex', alignItems:'center', justifyContent:'center',
        background:'rgba(0,5,20,0.9)', pointerEvents:'all', zIndex:'20'
      });
      this.hud.appendChild(this.overlay);
    }

    // ── Menu states ────────────────────────────────────────────────────────
    _showMenu() {
      this.overlay.style.display = 'flex';
      this.overlay.innerHTML =
        `<div style="text-align:center;color:#00D9FF;max-width:420px;padding:24px">
           <h1 style="font-size:2rem;letter-spacing:4px;margin:0 0 8px">VOXEL DISINTEGRATOR</h1>
           <p style="color:#aaa;margin:0 0 4px">Survive ${this.GAME_DURATION} seconds. Click to shoot.</p>
           <p style="color:#555;font-size:11px;margin:0 0 24px">
             WASD · Move &nbsp;|&nbsp; Move mouse · Aim &nbsp;|&nbsp; Click · Shoot &nbsp;|&nbsp; L · Mouse-look &nbsp;|&nbsp; ESC · Pause &nbsp;|&nbsp; 1–4 · Quality
           </p>
           <button id="_vsStart" style="${BTN_PRIMARY}">▶ START</button>
         </div>`;
      this.overlay.querySelector('#_vsStart').onclick = () => this._startGame();
    }

    _showPause() {
      this.overlay.style.display = 'flex';
      this.overlay.innerHTML =
        `<div style="text-align:center;color:#00D9FF">
           <h2 style="letter-spacing:4px;margin:0 0 8px">⏸ PAUSED</h2>
           <p style="color:#aaa;font-size:12px;margin:0 0 20px">Press ESC to resume</p>
           <button id="_vsResume" style="${BTN_PRIMARY}">▶ RESUME</button>
           <button id="_vsMenu"   style="${BTN_OUTLINE_CYAN};margin-left:8px">🏠 MENU</button>
         </div>`;
      this.overlay.querySelector('#_vsResume').onclick = () => this._resume();
      this.overlay.querySelector('#_vsMenu').onclick   = () => { this._resetToMenu(); };
    }

    _showWin() {
      document.exitPointerLock();
      this.crosshair.style.display = 'none';
      this.overlay.style.display   = 'flex';
      this.overlay.innerHTML =
        `<div style="text-align:center;color:#4ade80;max-width:420px;padding:24px">
           <h1 style="font-size:2rem;letter-spacing:4px;margin:0 0 8px">🎉 YOU WIN!</h1>
           <p style="color:#aaa;margin:0 0 4px">SURVIVAL COMPLETE!</p>
           <p style="margin:4px 0 20px">Enemies Eliminated: <strong style="color:#4ade80">${this.enemiesDestroyed}</strong></p>
           <button id="_vsAgain" style="${BTN_GREEN}">▶ PLAY AGAIN</button>
           <button id="_vsMenu2" style="${BTN_OUTLINE_GREEN};margin-left:8px">🏠 MENU</button>
         </div>`;
      this.overlay.querySelector('#_vsAgain').onclick = () => { this._clearEnemies(); this._startGame(); };
      this.overlay.querySelector('#_vsMenu2').onclick = () => this._resetToMenu();
      if (this.dotnet) this.dotnet.invokeMethodAsync('OnGameResult', true, this.enemiesDestroyed).catch(()=>{});
    }

    _showLose(reason) {
      document.exitPointerLock();
      this.crosshair.style.display = 'none';
      this.overlay.style.display   = 'flex';
      this.overlay.innerHTML =
        `<div style="text-align:center;color:#FF3366;max-width:420px;padding:24px">
           <h1 style="font-size:2rem;letter-spacing:4px;margin:0 0 8px">💥 GAME OVER</h1>
           <p style="color:#aaa;margin:0 0 4px">${reason}</p>
           <p style="margin:4px 0 20px">Enemies Eliminated: <strong style="color:#FF3366">${this.enemiesDestroyed}</strong></p>
           <button id="_vsAgain2" style="${BTN_RED}">▶ PLAY AGAIN</button>
           <button id="_vsMenu3"  style="${BTN_OUTLINE_RED};margin-left:8px">🏠 MENU</button>
         </div>`;
      this.overlay.querySelector('#_vsAgain2').onclick = () => { this._clearEnemies(); this._startGame(); };
      this.overlay.querySelector('#_vsMenu3').onclick  = () => this._resetToMenu();
      if (this.dotnet) this.dotnet.invokeMethodAsync('OnGameResult', false, this.enemiesDestroyed).catch(()=>{});
    }

    _resetToMenu() {
      this._clearEnemies();
      this.hudBar.style.display = 'none';
      this.crosshair.style.display = 'none';
      this.state = 'menu';
      this._showMenu();
    }

    // ── Game flow ──────────────────────────────────────────────────────────
    _startGame() {
      this.state = 'playing';
      this.score = 0;
      this.enemiesDestroyed = 0;
      this.startTime = performance.now();
      this.totalPausedMs = 0;
      this.lastSpawnTime = 0;
      this.ENEMY_SPEED = 10;
      this._clearEnemies();
      this.particles = [];
      this.playerPos.set(0, 1, 0);
      this.yaw = 0; this.pitch = 0;

      this.overlay.style.display = 'none';
      this.hudBar.style.display  = 'flex';
      this.crosshair.style.display = 'block';
      this.tracers = [];
      // Default to cursor-position aim (no pointer lock auto-request, which can
      // emit an un-catchable console error in embedded/automation contexts).
      // Players can opt into immersive mouse-look with the L key.
    }

    _pause() {
      if (this.state !== 'playing') return;
      this.state = 'paused';
      this.pauseTime = performance.now();
      document.exitPointerLock();
      this.crosshair.style.display = 'none';
      this._showPause();
    }

    _resume() {
      if (this.state !== 'paused') return;
      this.totalPausedMs += performance.now() - this.pauseTime;
      this.state = 'playing';
      this.overlay.style.display = 'none';
      this.crosshair.style.display = 'block';
    }

    _toggleLock() {
      if (this.isLocked) { try { document.exitPointerLock(); } catch (e) { /* ignore */ } }
      else this._requestLock();
    }

    // Best-effort pointer lock. Returns silently if the environment forbids it
    // (e.g. sandboxed iframe / no user-gesture). The modern API returns a
    // Promise that can reject — swallow it so it never hits the console, and
    // the cursor-position fallback aim in _mm takes over automatically.
    _requestLock() {
      try {
        const el = this.renderer.domElement;
        const p = el.requestPointerLock ? el.requestPointerLock() : null;
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) { /* pointer lock unavailable — fallback aim is used */ }
    }

    _clearEnemies() {
      this.enemies.forEach(e => e.dispose(this.scene));
      this.enemies = [];
      this.particles.forEach(p => { this.scene.remove(p.pts); p.pts.geometry.dispose(); p.pts.material.dispose(); });
      this.particles = [];
    }

    // ── Input ──────────────────────────────────────────────────────────────
    _bindInput() {
      this._kd = e => {
        if (e.code === 'KeyW') this.input.w = true;
        if (e.code === 'KeyS') this.input.s = true;
        if (e.code === 'KeyA') this.input.a = true;
        if (e.code === 'KeyD') this.input.d = true;
        if (e.code === 'Escape') { if (this.state === 'playing') this._pause(); else if (this.state === 'paused') this._resume(); }
        if (e.code === 'KeyL' && this.state === 'playing') this._toggleLock();
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
        if (this.state !== 'playing') return;
        if (this.isLocked) {
          // Relative mouse-look (pointer lock active).
          this.yaw   -= e.movementX * 0.002;
          this.pitch -= e.movementY * 0.002;
        } else {
          // Fallback aim: map the cursor's position within the canvas to a
          // look direction so the game is fully playable without pointer lock.
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
        if (this.state !== 'playing') return;
        // Always shoot (the crosshair is screen-centre and the camera is aimed
        // there in both lock modes). Pointer lock is opt-in via the L key.
        this._shoot();
      };
      this._plc = () => { this.isLocked = document.pointerLockElement === this.renderer.domElement; };
      this._rsz = () => this._resize();

      window.addEventListener('keydown', this._kd);
      window.addEventListener('keyup',   this._ku);
      window.addEventListener('mousemove', this._mm);
      this.renderer.domElement.addEventListener('click', this._click);
      document.addEventListener('pointerlockchange', this._plc);
      window.addEventListener('resize', this._rsz);
    }

    // ── Shoot ──────────────────────────────────────────────────────────────
    _shoot() {
      this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera);
      const dir    = this.raycaster.ray.direction.clone();
      const muzzle = this.camera.position.clone().addScaledVector(dir, 1.2);

      const meshes = this.enemies.map(e => e.mesh);
      const hits   = this.raycaster.intersectObjects(meshes, false);
      const target = hits.length
        ? hits[0].point.clone()
        : this.camera.position.clone().addScaledVector(dir, 400);
      this._fireTracer(muzzle, target);

      if (!hits.length) return;

      const hit       = hits[0];
      const enemyIdx  = this.enemies.findIndex(e => e.mesh === hit.object);
      if (enemyIdx < 0) return;

      const enemy      = this.enemies[enemyIdx];
      const destroyed  = enemy.applyDamage(hit.point, 4.0);
      this.score += destroyed;
      this._spawnParticles(hit.point, destroyed);

      if (enemy.health <= 0) {
        enemy.dispose(this.scene);
        this.enemies.splice(enemyIdx, 1);
        this.enemiesDestroyed++;
        this.msgEl.textContent = '🎯 +KILL';
        setTimeout(() => { if (this.msgEl) this.msgEl.textContent = ''; }, 600);
      }
    }

    // ── Tracer ─────────────────────────────────────────────────────────────
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

    // ── Particles ──────────────────────────────────────────────────────────
    _spawnParticles(pos, count) {
      const n = Math.min(count * 2 + 10, 48);
      const geo = new THREE.BufferGeometry();
      const arr = new Float32Array(n * 3);
      const vel = [];
      for (let i = 0; i < n; i++) {
        arr[i*3]=pos.x; arr[i*3+1]=pos.y; arr[i*3+2]=pos.z;
        vel.push(new THREE.Vector3(
          (Math.random()-.5)*22, Math.random()*18+4, (Math.random()-.5)*22
        ));
      }
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const mat = new THREE.PointsMaterial({ color:0xff7700, size:0.6, sizeAttenuation:true, transparent:true });
      const pts = new THREE.Points(geo, mat);
      this.scene.add(pts);
      this.particles.push({ pts, vel, life:1.0 });
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

    // ── Player ─────────────────────────────────────────────────────────────
    _tickPlayer(dt) {
      const fwd   = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3( Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const vel   = new THREE.Vector3();
      if (this.input.w) vel.add(fwd);
      if (this.input.s) vel.sub(fwd);
      if (this.input.a) vel.sub(right);
      if (this.input.d) vel.add(right);
      if (vel.lengthSq() > 0) vel.normalize().multiplyScalar(this.MOVE_SPEED * dt);
      this.playerPos.add(vel);
      const L = 80;
      this.playerPos.x = Math.max(-L, Math.min(L, this.playerPos.x));
      this.playerPos.z = Math.max(-L, Math.min(L, this.playerPos.z));
      this.camera.position.copy(this.playerPos);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;
    }

    // ── Enemy spawn ─────────────────────────────────────────────────────────
    _spawnEnemy() {
      const ang = Math.random() * Math.PI * 2;
      const r   = 220 + Math.random() * 60;
      this.enemies.push(new VoxelEnemy(this.scene, Math.cos(ang)*r, 4, Math.sin(ang)*r));
    }

    // ── Main loop ───────────────────────────────────────────────────────────
    start() {
      this._lastT = performance.now();
      const loop = t => {
        if (this.disposed) return;
        this._raf = requestAnimationFrame(loop);
        const dt = Math.min((t - this._lastT) / 1000, 0.05);
        this._lastT = t;

        if (this.state === 'playing') {
          this._tickPlayer(dt);

          // Spawn
          const now = performance.now();
          if (!this.lastSpawnTime || now - this.lastSpawnTime > this.SPAWN_INTERVAL) {
            this._spawnEnemy();
            this.lastSpawnTime = now;
            const elapsed = (now - this.startTime - this.totalPausedMs) / 1000;
            this.ENEMY_SPEED = 10 + elapsed * 0.06;
          }

          // Update & check enemies
          for (let i = this.enemies.length - 1; i >= 0; i--) {
            const e = this.enemies[i];
            e.moveToward(this.playerPos, this.ENEMY_SPEED, dt);
            const d = e.group.position.distanceTo(this.playerPos);
            if (d < 5) { this.state = 'lose'; this._showLose('CRUSHED BY ENEMY!'); return; }
            if (d < 1) { e.dispose(this.scene); this.enemies.splice(i, 1); }
          }

          this._tickParticles(dt);
          this._tickTracers(dt);

          // HUD update
          const elapsedS   = Math.floor((performance.now() - this.startTime - this.totalPausedMs) / 1000);
          const remaining   = this.GAME_DURATION - elapsedS;
          this.timerEl.textContent = `⏱ ${elapsedS}s / ${this.GAME_DURATION}s`;
          this.killsEl.textContent = `🎯 KILLS: ${this.enemiesDestroyed}`;
          if (remaining <= 0) { this.state = 'win'; this._showWin(); return; }
          if (remaining <= 15 && !this.msgEl.textContent.startsWith('🎯'))
            this.msgEl.textContent = `⚠ ${remaining}s!`;
          else if (remaining > 15 && !this.msgEl.textContent.startsWith('🎯'))
            this.msgEl.textContent = '';
        }

        this.renderer.render(this.scene, this.camera);
      };
      this._raf = requestAnimationFrame(loop);
    }

    dispose() {
      this.disposed = true;
      if (this._raf) cancelAnimationFrame(this._raf);
      window.removeEventListener('keydown', this._kd);
      window.removeEventListener('keyup',   this._ku);
      window.removeEventListener('mousemove', this._mm);
      window.removeEventListener('resize',  this._rsz);
      document.removeEventListener('pointerlockchange', this._plc);
      document.exitPointerLock();
      this._clearEnemies();
      (this.tracers || []).forEach(t => { this.scene.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); });
      this.tracers = [];
      if (this.renderer) { this.renderer.dispose(); this.renderer.domElement.remove(); }
      if (this.hud) this.hud.remove();
    }
  }

  // ─── VoxelEnemy ───────────────────────────────────────────────────────────
  const GRID  = 7;       // 7×7×7 voxels per enemy
  const VSIZ  = 0.5;     // voxel size (world units)
  const HALF  = (GRID * VSIZ) / 2;

  const _sharedGeo = new THREE.BoxGeometry(VSIZ, VSIZ, VSIZ);
  const _dummy = new THREE.Object3D();
  const _col   = new THREE.Color();

  const PALETTES = [0xF72585, 0x4CC9F0, 0x7209B7, 0xFF6B35, 0x4ade80, 0xfbbf24, 0xef4444, 0x818cf8];

  class VoxelEnemy {
    constructor(scene, x, y, z) {
      const count = GRID * GRID * GRID;
      this.health    = count;
      this.maxHealth = count;

      const base = PALETTES[Math.floor(Math.random() * PALETTES.length)];
      const mat  = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.7 });

      this.mesh = new THREE.InstancedMesh(_sharedGeo, mat, count);
      this.mesh.castShadow = true;
      this.mesh.frustumCulled = false;

      // Local-space offsets for each voxel
      this._offsets = new Array(count);
      let idx = 0;
      for (let ix = 0; ix < GRID; ix++) {
        for (let iy = 0; iy < GRID; iy++) {
          for (let iz = 0; iz < GRID; iz++, idx++) {
            const lx = ix * VSIZ - HALF;
            const ly = iy * VSIZ;
            const lz = iz * VSIZ - HALF;
            this._offsets[idx] = { lx, ly, lz, alive: true };
            _dummy.position.set(lx, ly, lz);
            _dummy.scale.setScalar(1);
            _dummy.updateMatrix();
            this.mesh.setMatrixAt(idx, _dummy.matrix);
            _col.setHex(base);
            _col.r = Math.max(0, Math.min(1, _col.r + (Math.random()-.5)*.3));
            _col.g = Math.max(0, Math.min(1, _col.g + (Math.random()-.5)*.3));
            _col.b = Math.max(0, Math.min(1, _col.b + (Math.random()-.5)*.3));
            this.mesh.setColorAt(idx, _col);
          }
        }
      }
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

      // Parent group for cheap movement
      this.group = new THREE.Object3D();
      this.group.position.set(x, y, z);
      this.group.add(this.mesh);
      scene.add(this.group);
    }

    moveToward(target, speed, dt) {
      const gp = this.group.position;
      const dx = target.x - gp.x;
      const dz = target.z - gp.z;
      const len = Math.sqrt(dx*dx + dz*dz);
      if (len < 0.1) return;
      gp.x += (dx/len) * speed * dt;
      gp.z += (dz/len) * speed * dt;
    }

    applyDamage(worldHitPoint, blastRadius) {
      // Convert hit point to group's local space
      const local = this.group.worldToLocal(worldHitPoint.clone());
      const r2 = blastRadius * blastRadius;
      let destroyed = 0;

      for (let i = 0; i < this._offsets.length; i++) {
        const o = this._offsets[i];
        if (!o.alive) continue;
        const dx = o.lx - local.x;
        const dy = o.ly - local.y;
        const dz = o.lz - local.z;
        if (dx*dx + dy*dy + dz*dz <= r2) {
          o.alive = false;
          this.health--;
          destroyed++;
          _dummy.position.set(o.lx, o.ly, o.lz);
          _dummy.scale.setScalar(0);
          _dummy.updateMatrix();
          this.mesh.setMatrixAt(i, _dummy.matrix);
        }
      }
      if (destroyed > 0) this.mesh.instanceMatrix.needsUpdate = true;
      return destroyed;
    }

    dispose(scene) {
      scene.remove(this.group);
      this.mesh.dispose();
      this.mesh.material.dispose();
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function _el(tag, styles) {
    const el = document.createElement(tag);
    Object.assign(el.style, styles);
    return el;
  }

  const BTN_PRIMARY      = 'background:#00D9FF;color:#000;border:none;padding:12px 32px;font-size:1rem;cursor:pointer;letter-spacing:2px;font-weight:bold;font-family:monospace';
  const BTN_GREEN        = 'background:#4ade80;color:#000;border:none;padding:12px 32px;font-size:.95rem;cursor:pointer;font-weight:bold;font-family:monospace';
  const BTN_RED          = 'background:#FF3366;color:#fff;border:none;padding:12px 32px;font-size:.95rem;cursor:pointer;font-weight:bold;font-family:monospace';
  const BTN_OUTLINE_CYAN = 'background:transparent;color:#00D9FF;border:1px solid #00D9FF;padding:12px 28px;cursor:pointer;font-family:monospace';
  const BTN_OUTLINE_GREEN= 'background:transparent;color:#4ade80;border:1px solid #4ade80;padding:12px 28px;cursor:pointer;font-family:monospace';
  const BTN_OUTLINE_RED  = 'background:transparent;color:#FF3366;border:1px solid #FF3366;padding:12px 28px;cursor:pointer;font-family:monospace';

})();
