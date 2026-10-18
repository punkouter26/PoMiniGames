// ledBoards.js — showtime module (see show.js). Mixin, `this` is the live game.
//
// Three pieces of hall dressing that ride the show bus and the crowd's beat clock:
//   • LED ribbon boards: a dot-matrix strip wrapped round the ring apron skirt (all four sides,
//     one continuous ribbon) and a ringside barrier in front of the first row. One ShaderMaterial:
//     round SDF pixels on a dark panel, quantised brightness, a slow scan glint. The message is a
//     tiny 1024×14 canvas (one texel = one LED) redrawn only when the text changes; the marquee
//     scrolls by a uniform, never by redrawing. Content and colour come from the bus (combos,
//     blocks, supers, KO, result, popular-vote split, upset alert) and the momentum leader's corner.
//   • Truss pulse: the rig lenses (game.js _rigLenses) get a beat pulse on top of game.js's own
//     envelope chase, scaled by the beat energy — a nudge early, punchy late in the round.
//   • Stadium wave: a travelling band round the stands (crowd shader uWave in arena.js lifts the
//     seats; phones in the band go bright) on peaks, with a cooldown; phones sway on the beat.
//
// Flicker rule: everything here is local emissive (thin boards, eight lenses, phone sprites); no
// whole-frame brightness. Reduced motion: no beat pulse, slow marquee, no wave, no sway.
// Every material is built here at init so _warmupRender compiles it; nothing compiles mid-fight.

import * as THREE from 'three';
import * as Quality from './quality.js';
import { PERSONALITIES } from './personalities.js';
import { MAX_HP } from './constants.js';

const ROWS = 14;               // LED rows (canvas height)
const TEX_W = 1024;            // message canvas width in LEDs
const PITCH = 0.03;            // metres per LED
const BOARD_H = ROWS * PITCH;  // 0.42 m
const APRON = 6.012;           // just proud of the ring box's skirt (half 6)
const APRON_Y0 = -0.47;        // the skirt spans y -0.5..0
// Ringside barrier just inside the first row (7.6 ± 0.2): a ~1 m wall from the floor (-0.5)
// with the LED band on top (0.06..0.48), high enough to read over the ring edge from the
// house camera. Outside the radius the director's low 'ringside' lens normally works in.
const FASCIA_R = 7.2;
const FASCIA_Y0 = 0.06;
const WALL_TOP = FASCIA_Y0 + BOARD_H + 0.04;
const FASCIA_SEGS = 96;
const TIME_LIMIT = 60;         // game.js TIME_LIMIT
const SEP = '   ◆   ';     // ◆ between repeats

const NEUTRAL = 0xffb23c;      // amber house colour
const CORNER = [0xff4636, 0x4f86ff]; // fighters[0] red (−X), fighters[1] blue (+X) — arena.js
// Per-colour gain: cores just over the bloom threshold without AgX bleaching them to white.
const GAIN = { [NEUTRAL]: 1.2, [CORNER[0]]: 1.25, [CORNER[1]]: 1.45, 0xfff0d0: 1.0, 0xffd23c: 1.2, 0xcfe0ff: 1.0 };

const WAVE_LAP = 5.2;          // seconds per lap of the stands
const WAVE_LAPS = 1.35;
const WAVE_RISE = 0.45;        // metres a seat lifts at the crest
const WAVE_W = 0.36;           // band half-width (radians)
const WAVE_CD = 13;            // seconds between waves

const _col = new THREE.Color();

const VERT = /* glsl */`
  varying vec2 vM;
  void main() {
    vM = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const FRAG = /* glsl */`
  uniform sampler2D uMsg;
  uniform float uMsgW;
  uniform float uScroll;
  uniform vec3 uCol;
  uniform vec3 uBack;
  uniform float uGain;
  uniform float uTime;
  uniform float uFancy;
  varying vec2 vM;
  float ledHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec2 d = vM / PITCH;
    vec2 cell = floor(d);
    vec2 f = fract(d) - 0.5;
    float col = mod(cell.x + uScroll, uMsgW);
    float lit = texture2D(uMsg, vec2((floor(col) + 0.5) / TEX_W, (cell.y + 0.5) / ROWS)).r;
    // Three brightness steps, like a real panel; faint anti-aliased fringes drop out so
    // letter counters stay open.
    lit = floor(lit * 3.0 + 0.15) / 3.0;
    float r = length(f);
    float aa = max(fwidth(d.x), fwidth(d.y));
    float dotM = 1.0 - smoothstep(0.34 - aa * 0.7, 0.34 + aa * 0.7, r);
    dotM = mix(dotM, 0.38, smoothstep(0.45, 1.1, aa)); // far off: average coverage, no moire
    float glow = exp(-r * r * 7.0) * 0.32 * uFancy;
    float jitter = 1.0 - 0.14 * uFancy * ledHash(cell);
    // A slow diagonal glint sweeping the ribbon.
    float sweep = mod(cell.x * 0.7 - cell.y * 1.6 - uTime * 70.0, 420.0) - 210.0;
    float scan = 1.0 + 0.16 * uFancy * exp(-sweep * sweep / 260.0);
    vec3 on = uCol * (dotM + glow) * lit * jitter * scan * uGain;
    vec3 off = uBack * (dotM * 0.6 + 0.12);
    gl_FragColor = vec4(on + off, 1.0);
  }`;

// One ribbon of quads along a polyline, uv in metres (u along, v up) so one LED pitch fits
// every board. The path runs left→right as seen from the side the board faces.
function ribbonGeometry(points, y0, h) {
  const pos = [], uv = [], idx = [];
  let u = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i], [bx, bz] = points[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const base = pos.length / 3;
    pos.push(ax, y0, az, bx, y0, bz, ax, y0 + h, az, bx, y0 + h, bz);
    uv.push(u, 0, u + len, 0, u, h, u + len, h);
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    u += len;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const reducedMotion = () => document.documentElement.getAttribute('data-motion') === 'reduce';
const superName = (f) => {
  const mode = PERSONALITIES[f?.charId]?.onSuper?.mode || 'super';
  const words = mode.replace(/([A-Z])/g, ' $1').toUpperCase();
  const who = (f?.rig?.config?.name || '').toUpperCase();
  return who ? `${who}: ${words}!` : `${words}!`;
};

class LedBoardsMethods {
  _initLedBoards() {
    if (!this.scene || !this.arena) return;
    const canvas = document.createElement('canvas');
    canvas.width = TEX_W; canvas.height = ROWS;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;

    const uniforms = {
      uMsg: { value: tex },
      uMsgW: { value: 1 },
      uScroll: { value: 0 },
      uCol: { value: new THREE.Color(NEUTRAL).multiplyScalar(GAIN[NEUTRAL]) },
      uBack: { value: new THREE.Color(0x000000) },
      uGain: { value: 1 },
      uTime: { value: 0 },
      uFancy: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms, vertexShader: VERT, fragmentShader: FRAG,
      defines: { PITCH: PITCH.toFixed(4), ROWS: ROWS.toFixed(1), TEX_W: TEX_W.toFixed(1) },
      fog: false,
    });

    const group = new THREE.Group();
    group.userData.kind = 'ledBoards';
    // Apron: one continuous ribbon counter-clockwise from above, so it reads left→right
    // from outside every side and the marquee runs round the corners.
    const a = APRON;
    const apronGeo = ribbonGeometry([[-a, a], [a, a], [a, -a], [-a, -a], [-a, a]], APRON_Y0, BOARD_H);
    const apron = new THREE.Mesh(apronGeo, mat);
    group.add(apron);

    // Ringside barrier: an inward-facing LED band on a dark wall in front of the first row.
    const ring = [];
    for (let i = 0; i <= FASCIA_SEGS; i++) {
      const th = -(i / FASCIA_SEGS) * Math.PI * 2;
      ring.push([Math.sin(th) * FASCIA_R, Math.cos(th) * FASCIA_R]);
    }
    const fasciaGeo = ribbonGeometry(ring, FASCIA_Y0, BOARD_H);
    const fascia = new THREE.Mesh(fasciaGeo, mat);
    const wallGeo = new THREE.CylinderGeometry(FASCIA_R + 0.03, FASCIA_R + 0.03, WALL_TOP + 0.5, FASCIA_SEGS, 1, true);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x0b0d18, roughness: 0.8, metalness: 0.2, side: THREE.DoubleSide });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.y = (WALL_TOP - 0.5) / 2;
    const barrier = new THREE.Group();
    barrier.add(fascia, wall);
    group.add(barrier);
    this.scene.add(group);

    // Phones: a hot (HDR) twin of the shared phone material for the wave band, plus
    // per-phone seat angle. A hidden keeper sprite gets it compiled at warm-up.
    const phones = this.arena.phones;
    let hotMat = null, keeper = null;
    if (phones?.mat) {
      hotMat = phones.mat.clone();
      hotMat.color.setScalar(2.4);
      hotMat.opacity = 0.95;
      keeper = new THREE.Sprite(hotMat);
      keeper.visible = false;
      keeper.scale.setScalar(0.001);
      group.add(keeper);
      for (const s of phones.pool) {
        const b = s.userData.base;
        s.userData.ang = Math.atan2(b.x, b.z);
      }
    }

    this._led = {
      canvas, ctx, tex, mat, uniforms, group, barrier, apronGeo, fasciaGeo, wallGeo, wallMat, hotMat,
      text: '', flash: '', flashT: 0, flashPrio: -1, flashHex: null, pop: 0,
      idleT: 99, scroll: 0, time: 0, reduce: reducedMotion(),
      mom: 0, momRecent: 0, leader: -1,
      deficit: [0, 0], comebackDone: [false, false], last10: false, upsetArmed: true,
      // Beat (fallback clock when the audio show has not published this.beat).
      fbT: 0, pulse: 0, energy: 0, phase: 0, beatN: 0,
      lensBase: [], lensSet: [],
      wave: { t: -1, a0: 0, dir: 1, env: 0 }, waveCd: 4, hiE: 0,
    };

    // Low tier: flat dots (no glow, glint or per-LED jitter). A uniform, so no recompile.
    const applyTier = (t) => { uniforms.uFancy.value = t === 'low' ? 0 : 1; };
    applyTier(Quality.tier());
    this._led.unTier = Quality.onTierChange(applyTier);

    this._ledSetText(this._ledIdleText());
    this._onShow((type, d) => this._ledOnShow(type, d));
    this._onShowUpdate((dt) => this._ledUpdate(dt));
    this._onShowDispose(() => this._ledDispose());
  }

  // ── Content ─────────────────────────────────────────────────────────
  _ledIdleText() {
    const fs = this.fighters;
    const names = fs ? fs.map((f) => (f.rig?.config?.name || '').toUpperCase()) : ['', ''];
    const parts = [];
    if (this._cup && this._cup.upset > 0.5) parts.push('UPSET ALERT');
    parts.push('DEBATE NIGHT');
    if (names[0] && names[1]) parts.push(`${names[0]} vs ${names[1]}`);
    parts.push(this.options?.mode === 'tournament' ? (this.options.roundLabel || 'TOURNAMENT').toUpperCase() : 'MAIN EVENT');
    if (fs) {
      const h0 = fs[0].stats?.hits || 0, h1 = fs[1].stats?.hits || 0;
      if (h0 + h1 >= 2) {
        const p0 = Math.round((100 * h0) / (h0 + h1));
        parts.push(`POPULAR VOTE ${p0}% – ${100 - p0}%`);
      }
    }
    return parts.join(SEP);
  }

  _ledSetText(text) {
    const L = this._led;
    if (!L || text === L.text) return;
    L.text = text;
    const g = L.ctx;
    g.fillStyle = '#000';
    g.fillRect(0, 0, TEX_W, ROWS);
    // Bold Arial reads better than Impact at 14 LEDs tall: Impact's counters fill in.
    g.font = 'bold 12px Arial, Helvetica, sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = '#fff';
    const unit = text + SEP;
    const w = Math.min(TEX_W, Math.ceil(g.measureText(unit).width));
    g.fillText(unit, 0, ROWS / 2 + 1);
    L.uniforms.uMsgW.value = Math.max(8, w);
    L.scroll %= L.uniforms.uMsgW.value;
    L.tex.needsUpdate = true;
  }

  /** A one-off message: higher priority wins while it runs; `hex` overrides the momentum colour. */
  _ledFlash(text, secs, hex = null, prio = 1) {
    const L = this._led;
    if (!L) return;
    if (L.flashT > 0 && prio < L.flashPrio) return;
    L.flash = text; L.flashT = secs; L.flashPrio = prio; L.flashHex = hex;
    L.pop = 1;
    this._ledSetText(text);
  }

  _ledOnShow(type, d) {
    const L = this._led;
    if (!L) return;
    switch (type) {
      case 'reset':
        this._ledWaveStop();
        L.waveCd = 4;
        // falls through
      case 'countdown':
        L.flashT = 0; L.flashPrio = -1; L.mom = 0; L.momRecent = 0; L.leader = -1;
        L.deficit[0] = L.deficit[1] = 0; L.comebackDone[0] = L.comebackDone[1] = false;
        L.last10 = false; L.idleT = 99;
        break;
      case 'fight':
        this._ledFlash('FIGHT!', 1.6, 0xffd23c, 1);
        break;
      case 'hit': {
        const att = d.attacker;
        const i = this.fighters ? this.fighters.indexOf(att) : -1;
        if (i >= 0) L.momRecent = Math.max(-1.5, Math.min(1.5, L.momRecent + (i === 0 ? 1 : -1) * Math.min(1, (d.dmg || 0) / 14) * 0.5));
        const n = att?.comboN || 0;
        if (n >= 3) this._ledFlash(`${n} HIT COMBO!`, 1.7, null, 1);
        if (n >= 5) this._ledWave('combo');
        L.idleT = 99; // the vote split moved
        break;
      }
      case 'block':
        if (L.flashT <= 0) this._ledFlash('BLOCKED', 0.9, 0xcfe0ff, 0);
        break;
      case 'super':
        this._ledFlash(superName(d.f), 3.2, 0xffd23c, 2);
        break;
      case 'ko':
        this._ledFlash('KNOCKOUT', 60, 0xfff0d0, 3);
        this._ledWave('ko', true);
        break;
      case 'result': {
        const w = d.winner ? this.fighters?.[d.winner - 1] : null;
        const name = w ? `${(w.rig?.config?.name || '').toUpperCase()} WINS` : 'DRAW';
        this._ledFlash(d.ko ? `${name} BY KNOCKOUT` : name, 60, w ? CORNER[d.winner - 1] : NEUTRAL, 4);
        this._ledWave('result');
        break;
      }
      default: break;
    }
  }

  // ── Beat ────────────────────────────────────────────────────────────
  // The audio show publishes this.beat; standalone, a 120 bpm clock with an energy read
  // off the excitement, the round clock and the lowest HP.
  _ledBeat(dt) {
    const L = this._led;
    const b = this.beat;
    let e;
    if (b && typeof b.pulse === 'number') {
      L.pulse = b.pulse; L.phase = b.phase || 0; L.beatN = b.beatN || 0;
      e = typeof b.energy === 'number' ? b.energy : null;
    } else {
      L.fbT += dt;
      const beats = L.fbT * 2;
      L.beatN = Math.floor(beats); L.phase = beats - L.beatN;
      L.pulse = Math.exp(-L.phase * 5);
      e = null;
    }
    if (e === null) {
      const fs = this.fighters;
      const lowest = fs && this._hp ? Math.min(this._hp(fs[0]), this._hp(fs[1])) / MAX_HP : 1;
      const late = Math.min(1, (this.clock || 0) / TIME_LIMIT);
      e = Math.min(1, 0.15 + (this.excited || 0) * 0.45 + late * 0.3 + (1 - lowest) * 0.25);
      if (this.phase !== 'fighting' && this.phase !== 'ko') e *= 0.6;
    }
    L.energy = Math.max(0, Math.min(1, e));
  }

  // ── Per frame ───────────────────────────────────────────────────────
  _ledUpdate(dt) {
    const L = this._led;
    if (!L) return;
    this._ledBeat(dt);
    const U = L.uniforms;
    L.time = (L.time + dt) % 1000;
    U.uTime.value = L.time;

    // Slow bookkeeping: reduced motion, the idle message, round triggers.
    L.idleT += dt;
    if (L.idleT >= 0.3) {
      L.idleT = 0;
      L.reduce = reducedMotion();
      this._ledTick();
      if (L.flashT <= 0) this._ledSetText(this._ledIdleText());
    }
    if (L.flashT > 0) {
      L.flashT -= dt;
      if (L.flashT <= 0) { L.flashPrio = -1; L.idleT = 99; }
    }

    // Marquee: whole-LED steps come free from the shader's floor().
    const speed = L.reduce ? 7 : (L.flashT > 0 ? 30 : 20);
    L.scroll = (L.scroll + speed * dt) % U.uMsgW.value;
    U.uScroll.value = L.scroll;

    // Colour: the flash's own, else the momentum leader's corner, eased.
    const hex = L.flashT > 0 && L.flashHex !== null ? L.flashHex : (L.leader < 0 ? NEUTRAL : CORNER[L.leader]);
    _col.setHex(hex).multiplyScalar(GAIN[hex] || 1.3);
    U.uCol.value.lerp(_col, 1 - Math.exp(-dt * 5));
    U.uBack.value.copy(U.uCol.value).multiplyScalar(0.03);
    U.uBack.value.r += 0.004; U.uBack.value.g += 0.005; U.uBack.value.b += 0.01;

    // Beat amount: a nudge at low energy, punchy late. Reduced motion: none.
    const e = L.energy;
    const amt = L.reduce ? 0 : L.pulse * (0.12 + 0.88 * e * e);
    L.pop = Math.max(0, L.pop - dt * 2.2);
    U.uGain.value = (1 + 0.22 * amt) * (1 + 0.3 * L.pop);

    this._ledTruss(amt);
    this._ledWaveUpdate(dt);
  }

  // Momentum leader, comebacks, the last ten seconds, the tournament upset.
  _ledTick() {
    const L = this._led, fs = this.fighters;
    if (!fs || !this._hp) return;
    const hp0 = this._hp(fs[0]), hp1 = this._hp(fs[1]);
    L.momRecent *= 0.93; // ~4 s decay at this 0.3 s cadence
    L.mom = Math.max(-1, Math.min(1, (hp0 - hp1) / 30)) * 0.6 + L.momRecent * 0.5;
    if (L.mom > 0.18) L.leader = 0;
    else if (L.mom < -0.18) L.leader = 1;
    else if (Math.abs(L.mom) < 0.05) L.leader = -1;

    if (this.phase !== 'fighting' || this.training) return;
    // Comeback: a fighter who trailed by 25+ HP this round now leads.
    for (let i = 0; i < 2; i++) {
      const mine = i === 0 ? hp0 : hp1, theirs = i === 0 ? hp1 : hp0;
      L.deficit[i] = Math.max(L.deficit[i], theirs - mine);
      if (!L.comebackDone[i] && L.deficit[i] >= 25 && mine > theirs) {
        L.comebackDone[i] = true;
        this._ledFlash(`${(fs[i].rig?.config?.name || '').toUpperCase()} COMEBACK!`, 2.4, CORNER[i], 2);
        this._ledWave('comeback');
      }
    }
    if (!L.last10 && !this.online && TIME_LIMIT - (this.clock || 0) <= 10) {
      L.last10 = true;
      this._ledFlash('FINAL 10 SECONDS', 2.2, 0xffd23c, 2);
      this._ledWave('last10');
    }
    const upset = this._cup ? this._cup.upset : 0;
    if (L.upsetArmed && upset > 0.5) {
      L.upsetArmed = false;
      this._ledFlash('UPSET ALERT', 2.6, 0xffd23c, 2);
      this._ledWave('upset');
    } else if (!L.upsetArmed && upset < 0.3) L.upsetArmed = true;
    // A long hot stretch on the beat clock.
    L.hiE = L.energy > 0.85 ? L.hiE + 0.3 : 0;
    if (L.hiE >= 1.2) this._ledWave('energy');
  }

  // Rig lenses: game.js _updateReactiveArena writes their intensity every frame before the show
  // update; this multiplies on top. If nobody rewrote a lens since our last frame, our own base is
  // reused so the pulse never compounds.
  _ledTruss(amt) {
    const lenses = this._rigLenses, L = this._led;
    if (!lenses || !lenses.length) return;
    const e = L.energy;
    const off = L.reduce ? 0 : Math.exp(-(((L.phase + 0.5) % 1)) * 5) * Math.max(0, (e - 0.55) / 0.45);
    for (let i = 0; i < lenses.length; i++) {
      const m = lenses[i].material;
      const cur = m.emissiveIntensity;
      const base = (L.lensSet[i] !== undefined && Math.abs(cur - L.lensSet[i]) < 1e-6) ? L.lensBase[i] : cur;
      // Odd lamps take the off-beat once the hall is hot, so the truss chases.
      const p = (i & 1) && off > 0 ? Math.max(amt * 0.4, off * (0.12 + 0.88 * e * e)) : amt;
      const v = base * (1 + 0.9 * p);
      m.emissiveIntensity = v;
      L.lensBase[i] = base; L.lensSet[i] = v;
    }
  }

  // ── Stadium wave ────────────────────────────────────────────────────
  /** Start a wave unless one is running or cooling down (`force` skips the cooldown). */
  _ledWave(reason, force = false) {
    const L = this._led;
    if (!L || L.reduce || L.wave.t >= 0) return false;
    if (!force && L.waveCd > 0) return false;
    const u = this.arena?.crowd?.userData?.uniforms?.uWave;
    if (!u) return false;
    L.wave.t = 0;
    L.wave.a0 = Math.random() * Math.PI * 2;
    L.wave.dir = Math.random() < 0.5 ? -1 : 1;
    L.wave.reason = reason;
    return true;
  }

  _ledWaveStop() {
    const L = this._led;
    if (!L) return;
    L.wave.t = -1; L.wave.env = 0;
    const u = this.arena?.crowd?.userData?.uniforms?.uWave;
    if (u) u.value.y = 0;
    const ph = this.arena?.phones;
    if (ph) {
      for (const s of ph.pool) {
        s.userData.lift = 0; s.userData.dx = 0; s.userData.dz = 0;
        s.scale.set(0.06, 0.1, 1);
        if (s.material !== ph.mat) s.material = ph.mat;
      }
    }
  }

  _ledWaveUpdate(dt) {
    const L = this._led, W = L.wave;
    const u = this.arena?.crowd?.userData?.uniforms?.uWave;
    const ph = this.arena?.phones;
    if (L.waveCd > 0) L.waveCd -= dt;
    if (W.t >= 0 && L.reduce) this._ledWaveStop();

    let ang = 0, env = 0;
    if (W.t >= 0) {
      W.t += dt;
      const dur = WAVE_LAP * WAVE_LAPS;
      if (W.t >= dur) {
        this._ledWaveStop();
        L.waveCd = WAVE_CD;
      } else {
        env = Math.min(1, W.t / 0.7, (dur - W.t) / 0.9);
        env = env * env * (3 - 2 * env);
        ang = W.a0 + W.dir * (W.t / WAVE_LAP) * Math.PI * 2;
        W.env = env;
        if (u) u.value.set(ang, WAVE_RISE * env, WAVE_W, 0);
        // Phones come up for the wave (game.js eases _phoneLevel back down after).
        this._phoneLevel = Math.max(this._phoneLevel || 0, 0.8 * env);
      }
    }

    // Phones: the band's go bright and ride up with their seat; at high energy all sway on
    // the beat (one side-to-side per two beats), along the stand so it reads from the ring.
    if (!ph || !ph.group.visible && env <= 0) return;
    const swayAmp = L.reduce ? 0 : 0.09 * Math.max(0, Math.min(1, (L.energy - 0.55) / 0.3));
    const sway = swayAmp > 0 ? swayAmp * Math.sin((L.beatN + L.phase) * Math.PI) : 0;
    for (const s of ph.pool) {
      const ud = s.userData;
      let band = 0;
      if (env > 0) {
        let dA = ud.ang - ang + Math.PI;
        dA -= Math.floor(dA / (Math.PI * 2)) * Math.PI * 2;
        dA -= Math.PI;
        band = env * Math.exp(-(dA * dA) / (WAVE_W * WAVE_W));
      }
      ud.lift = band * WAVE_RISE;
      ud.dx = Math.cos(ud.ang) * sway;
      ud.dz = -Math.sin(ud.ang) * sway;
      const k = 1 + band * 0.9;
      s.scale.set(0.06 * k, 0.1 * k, 1);
      const want = band > 0.3 && L.hotMat ? L.hotMat : ph.mat;
      if (s.material !== want) s.material = want;
    }
  }

  /** Debug read-out for the headless harness. */
  _ledProbe() {
    const L = this._led;
    if (!L) return null;
    return {
      text: L.text, flash: L.flashT > 0 ? L.flash : '', leader: L.leader, mom: +L.mom.toFixed(2),
      energy: +L.energy.toFixed(2), pulse: +L.pulse.toFixed(2), beatSrc: this.beat ? 'audio' : 'fallback',
      wave: L.wave.t >= 0 ? { t: +L.wave.t.toFixed(2), reason: L.wave.reason } : null, waveCd: +L.waveCd.toFixed(1),
      fancy: L.uniforms.uFancy.value, reduce: L.reduce, msgW: L.uniforms.uMsgW.value,
      lens0: this._rigLenses?.[0]?.material.emissiveIntensity,
    };
  }

  _ledDispose() {
    const L = this._led;
    if (!L) return;
    try { L.unTier?.(); } catch { /* ignore */ }
    this._ledWaveStop();
    L.group.parent?.remove(L.group);
    L.apronGeo.dispose(); L.fasciaGeo.dispose(); L.wallGeo.dispose();
    L.mat.dispose(); L.wallMat.dispose(); L.tex.dispose();
    L.hotMat?.dispose();
    this._led = null;
  }
}

export const LedBoards = LedBoardsMethods.prototype;
