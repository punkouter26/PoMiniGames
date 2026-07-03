// game.js — PoBrawl match orchestrator: scene, Virtua-Fighter-style camera, fixed-timestep
// simulation, per-fighter combat state machines, hit resolution and .NET callbacks.
import * as THREE from 'three';
import { buildArena, RING_HALF } from './arena.js';
import { buildFighter, CHARACTER_IDS, CHARACTERS } from './fighters.js';
import { Animator } from './animation.js';
import { KeyboardController } from './input.js';
import { AiController } from './ai.js';
import { RandomGenerator } from './rng.js';
import { CombatPlay, COMBAT_EVENTS } from './combat.js';

const SIM_DT = 1 / 60;
const MAX_FRAME_DT = 0.05;
const MAX_HP = 100;
const TIME_LIMIT = 99;
const MIN_SEPARATION = 0.9;

const ATTACKS = {
  punch: { windup: 0.08, active: 0.1, recover: 0.22, dmg: 8, reach: 1.5 },
  kick: { windup: 0.12, active: 0.12, recover: 0.3, dmg: 12, reach: 1.85 },
};

const HITSTUN = 0.35;

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
    this.effects = [];
    this.audioCtx = null;
    // Seeded RNG so a demo/kiosk replay is reproducible; falls back to a fixed seed.
    this.rng = new RandomGenerator((options && options.seed) || 1337);
  }

  start() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 540;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    buildArena(this.scene);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 100);
    this.camera.position.set(0, 2.4, 7);

    this.banner = document.createElement('div');
    this.banner.className = 'pb-banner';
    this.container.appendChild(this.banner);

    this._onResize = () => {
      const cw = this.container.clientWidth, ch = this.container.clientHeight;
      if (!cw || !ch) return;
      this.camera.aspect = cw / ch;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(cw, ch);
    };
    window.addEventListener('resize', this._onResize);

    this._spawnFighters(this.options.p1Character, this.options.p2Character);
    this._startCountdown();

    this.lastFrame = performance.now();
    const loop = (now) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      let dt = Math.min((now - this.lastFrame) / 1000, MAX_FRAME_DT);
      this.lastFrame = now;
      this.accumulator += dt * this.timeScale;
      while (this.accumulator >= SIM_DT) {
        this.accumulator -= SIM_DT;
        this._tick(SIM_DT);
      }
      this._updateCamera(dt);
      this._updateEffects(dt);
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  // ── setup ───────────────────────────────────────────────────────────────

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
        this.scene.remove(f.rig.root);
        f.controller.dispose();
      }
    }

    // Health, death and winner resolution live in CombatPlay; each fighter is its own team.
    this.combat = new CombatPlay({ maxHealth: MAX_HP });

    this.fighters = [1, 2].map((index) => {
      const charId = index === 1 ? p1Char : p2Char;
      const rig = buildFighter(CHARACTERS[charId] ? charId : CHARACTER_IDS[0]);
      rig.root.position.set(index === 1 ? -1.6 : 1.6, 0, 0);
      this.scene.add(rig.root);
      const playerId = `p${index}`;
      this.combat.addPlayer({ playerId, teamId: String(index) });
      return {
        index,
        playerId,
        rig,
        animator: new Animator(rig.joints),
        controller: this._makeController(index),
        state: 'idle',
        stateT: 0,
        attack: null,
        hasHit: false,
        sideVel: new THREE.Vector3(),
        knockback: new THREE.Vector3(),
        idleT: this.rng.random() * 10,
        speedAmt: 0,
      };
    });
    this.hudDirty = true;
    this.hudTimer = 0;
  }

  // Current health of a fighter, read from the combat model.
  _hp(f) {
    return Math.max(0, Math.round(this.combat.getPlayer(f.playerId).health));
  }

  _startCountdown() {
    this.phase = 'countdown';
    this.phaseT = 0;
    this.clock = 0;
    this.winner = 0;
    this.timeScale = 1;
    this._setBanner('3');
  }

  resetMatch(randomize) {
    let p1 = this.options.p1Character, p2 = this.options.p2Character;
    if (randomize) {
      const ids = this.rng.shuffle(CHARACTER_IDS);
      [p1, p2] = ids;
    }
    this._spawnFighters(p1, p2);
    this._startCountdown();
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
        this._endMatch(h1 === h2 ? 0 : (h1 > h2 ? 1 : 2), 'TIME!');
      }
    } else if (this.phase === 'ko') {
      this._tickKoFall(dt);
      if (this.phaseT >= 1) {
        this.timeScale = 1;
        this.phase = 'result';
        this.phaseT = 0;
        this._reportResult();
      }
    } else if (this.phase === 'result') {
      this._tickKoFall(dt);
      if (this.options.mode === 'demo' && this.phaseT >= 3) {
        this.resetMatch(true);
      }
    }

    for (const f of this.fighters) {
      f.idleT += dt;
      f.animator.update({ dt, speed: f.speedAmt, idleT: f.idleT, snappy: false });
    }

    this._pushHud(dt);
  }

  _tickFighting(dt) {
    const [f1, f2] = this.fighters;

    for (const f of this.fighters) {
      const opp = f === f1 ? f2 : f1;
      const ctx = this._aiContext(f, opp, dt);
      const intent = f.controller.update(ctx);
      this._tickFighter(f, opp, intent, dt);
    }

    // Keep both inside the ring and apart.
    for (const f of this.fighters) {
      f.rig.root.position.x = THREE.MathUtils.clamp(f.rig.root.position.x, -RING_HALF, RING_HALF);
      f.rig.root.position.z = THREE.MathUtils.clamp(f.rig.root.position.z, -RING_HALF, RING_HALF);
    }
    const delta = f2.rig.root.position.clone().sub(f1.rig.root.position);
    delta.y = 0;
    const dist = delta.length();
    if (dist < MIN_SEPARATION && dist > 1e-4) {
      const push = delta.normalize().multiplyScalar((MIN_SEPARATION - dist) / 2);
      f1.rig.root.position.sub(push);
      f2.rig.root.position.add(push);
    }

    // Face each other (yaw only).
    for (const f of this.fighters) {
      const opp = f === f1 ? f2 : f1;
      if (f.state !== 'ko') {
        const p = opp.rig.root.position;
        f.rig.root.rotation.y = Math.atan2(p.x - f.rig.root.position.x, p.z - f.rig.root.position.z);
      }
    }
  }

  _aiContext(f, opp, dt) {
    const dist = f.rig.root.position.distanceTo(opp.rig.root.position);
    const oppWindup = (opp.state === 'punch' || opp.state === 'kick') &&
      opp.stateT < ATTACKS[opp.state].windup;
    return {
      dt,
      distance: dist,
      kickRange: ATTACKS.kick.reach * opp.rig.config.heightScale + 0.3,
      opponentWindup: oppWindup,
    };
  }

  _tickFighter(f, opp, intent, dt) {
    f.stateT += dt;
    const pos = f.rig.root.position;
    f.speedAmt = 0;

    // Decaying impulses always apply.
    pos.add(f.knockback.clone().multiplyScalar(dt));
    f.knockback.multiplyScalar(Math.max(0, 1 - dt * 8));
    pos.add(f.sideVel.clone().multiplyScalar(dt));
    f.sideVel.multiplyScalar(Math.max(0, 1 - dt * 10));

    switch (f.state) {
      case 'idle': {
        if (intent.punch || intent.kick) {
          f.state = intent.punch ? 'punch' : 'kick';
          f.stateT = 0;
          f.hasHit = false;
          f.animator.play(f.state);
          break;
        }
        if (intent.block) {
          f.state = 'block';
          f.animator.setBlocking(true);
          break;
        }
        // Movement: +move is toward the opponent; side steps are camera-relative
        // impulses perpendicular to the fight axis.
        const toward = opp.rig.root.position.clone().sub(pos);
        toward.y = 0;
        if (toward.lengthSq() > 1e-6) toward.normalize();
        if (intent.move !== 0) {
          const speed = intent.move > 0 ? 2.4 : 1.9;
          pos.add(toward.multiplyScalar(intent.move * speed * dt));
          f.speedAmt = 1;
        }
        if (intent.side !== 0) {
          const camDir = this._sideDirection();
          f.sideVel.add(camDir.multiplyScalar(intent.side * 5.5));
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
        if (f.stateT >= a.windup + a.active + a.recover) f.state = 'idle';
        break;
      }
      case 'hitstun': {
        if (f.stateT >= HITSTUN) f.state = 'idle';
        break;
      }
      case 'ko':
        break;
    }
  }

  // Direction "into the screen" so P1's W and P2's ↑ both step the same visual way.
  _sideDirection() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.y = 0;
    return dir.lengthSq() > 1e-6 ? dir.normalize() : new THREE.Vector3(0, 0, -1);
  }

  _tryHit(attacker, defender, attack) {
    const apos = attacker.rig.root.position, dpos = defender.rig.root.position;
    const to = dpos.clone().sub(apos);
    to.y = 0;
    const dist = to.length();
    const reach = attack.reach * attacker.rig.config.heightScale + 0.35;
    if (dist > reach) return;

    // A clean sidestep moves the defender off the attack line.
    const facing = new THREE.Vector3(Math.sin(attacker.rig.root.rotation.y), 0, Math.cos(attacker.rig.root.rotation.y));
    const lateral = Math.abs(to.clone().cross(facing).y);
    if (lateral > 0.55) return;

    attacker.hasHit = true;
    const knockDir = to.lengthSq() > 1e-6 ? to.normalize() : facing;

    if (defender.state === 'block') {
      defender.knockback.add(knockDir.clone().multiplyScalar(1.6));
      this._spawnSpark(dpos, 0x9ad0ff);
      this._sfx(220, 0.06);
      return;
    }

    const dmg = attack.dmg + this.rng.randint(-2, 2);
    this.combat.damage({ playerId: defender.playerId, amount: dmg, sourceId: attacker.playerId });
    defender.state = 'hitstun';
    defender.stateT = 0;
    defender.animator.setBlocking(false);
    defender.animator.play('hitstun');
    defender.knockback.add(knockDir.clone().multiplyScalar(4));
    if (defender.controller.notifyHit) defender.controller.notifyHit();
    this._spawnSpark(dpos, 0xffc857);
    this._sfx(120, 0.09);
    this.hudDirty = true;

    // Let CombatPlay resolve death/winner; react to the queued events.
    for (const ev of this.combat.step()) {
      if (ev.type === COMBAT_EVENTS.PLAYER_KILLED) {
        const downed = this.fighters.find((x) => x.playerId === ev.playerId);
        if (downed) downed.state = 'ko';
      } else if (ev.type === COMBAT_EVENTS.COMBAT_FINISHED) {
        this.phase = 'ko';
        this.phaseT = 0;
        this.timeScale = 0.4;
        this.winner = ev.winnerTeamId ? Number(ev.winnerTeamId) : 0;
        this._setBanner('K.O.!');
        this._sfx(70, 0.4);
      }
    }
  }

  _tickKoFall(dt) {
    for (const f of this.fighters) {
      if (f.state !== 'ko') continue;
      const root = f.rig.root;
      root.rotation.x = THREE.MathUtils.lerp(root.rotation.x, -1.35, Math.min(1, dt * 5));
      root.position.y = THREE.MathUtils.lerp(root.position.y, 0.15, Math.min(1, dt * 5));
    }
  }

  _endMatch(winner, bannerText) {
    this.winner = winner;
    this.phase = 'result';
    this.phaseT = 0;
    this._setBanner(bannerText);
    this._reportResult();
  }

  _reportResult() {
    const name = this.winner === 0
      ? 'DRAW'
      : `${this.fighters[this.winner - 1].rig.config.name.toUpperCase()} WINS!`;
    this._setBanner(name);
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

    // Perpendicular on whichever side the camera already is, so orbiting is continuous
    // and P1 stays on the left of the screen.
    const perp = new THREE.Vector3(axis.z, 0, -axis.x);
    if (perp.dot(this.camera.position.clone().sub(mid)) < 0) perp.negate();

    const distance = THREE.MathUtils.clamp(4 + sep * 0.55, 4.5, 9);
    const target = mid.clone().add(perp.multiplyScalar(distance));
    target.y = 2.2 + sep * 0.08;

    const k = 1 - Math.exp(-dt * 3);
    this.camera.position.lerp(target, k);
    this.camera.lookAt(mid.x, mid.y + 1, mid.z);
  }

  _spawnSpark(pos, color) {
    const spark = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 8, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 })
    );
    spark.position.set(pos.x, pos.y + 1.3, pos.z);
    this.scene.add(spark);
    this.effects.push({ mesh: spark, life: 0.25 });
  }

  _updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life -= dt;
      e.mesh.scale.multiplyScalar(1 + dt * 10);
      e.mesh.material.opacity = Math.max(0, e.life / 0.25);
      if (e.life <= 0) {
        this.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        e.mesh.material.dispose();
        this.effects.splice(i, 1);
      }
    }
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
      this.dotnet.invokeMethodAsync('OnHud',
        this._hp(this.fighters[0]), this._hp(this.fighters[1]), Math.round(this.clock * 10) / 10)
        .catch(() => {});
    }
  }

  _sfx(freq, dur) {
    if (this.muted) return;
    try {
      this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + dur);
    } catch { /* audio unavailable — play silently */ }
  }

  setMuted(m) {
    this.muted = !!m;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this._onResize);
    if (this.fighters) for (const f of this.fighters) f.controller.dispose();
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) m.dispose();
        }
      });
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    if (this.banner) this.banner.remove();
    this.dotnet = null;
  }
}
