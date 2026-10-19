// director.js — the broadcast director. In the CPU-only modes ('demo', 'tournament') nobody
// plays, so instead of the one fixed boom the camera cuts like a TV truck: a shot list of rigs,
// a director that picks the next one from fight events and a shot clock, and a small
// picture-in-picture "iso cam" on the fighter the main shot is not centred on.
// Mixed into BrawlGame's prototype (`this` is the live game) — see mixin.js.
//
// Ownership with the rest of the camera (cinematics.js _updateCamera):
//   KO and super keep their own branches and always win — the director only drives the
//   'normal' camera while the phase is 'fighting'. Player modes never reach this file.
// Randomness: Math.random only. `this.rng` is the seeded match RNG; drawing from it here
// would change demo replays and break online determinism.

import * as THREE from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as Quality from './quality.js';
import { MAX_HP, HEAVY_HIT_DMG } from './constants.js';

// Shot clock, seconds. Reduced motion holds every shot longer and never whip-pans.
const SHOT_LEN = { min: 2.5, max: 7 };
const CALM_LEN = { min: 4.5, max: 11 };
// Reaction cutaways are the one shot that may lose the fighters, so they stay brief.
const CUTAWAY_LEN = { min: 1.3, max: 2.0 };
// An event that lands before the minimum waits this long for it, then lapses.
const EVENT_TTL = 1.6;
// Matches commentary.js's "danger" line, so the push-in and the call land together.
const RED_HP = 25 * (MAX_HP / 100);
const WHIP_SEC = 0.24;
const WHIP_CHANCE = 0.18;
// Low rigs stay inside the first crowd row (r = 7.6 in arena.js); high ones clear its heads.
const LOW_RIG_Y = 1.3;
const LOW_RADIUS = 7.0;
const HIGH_RADIUS = 11;

// Unprompted cuts draw from this pool (weights). Event cuts pick from their own lists.
const POOL = [
  ['main', 3], ['wide', 2], ['ringside', 2], ['ots', 2.5], ['crane', 1.6], ['two', 2], ['reaction', 0.8],
];
const TIGHT = new Set(['two', 'ots', 'pushin']);

// Iso cam: share of the host width, 16:9, rendered below the inset's device pixels.
const ISO_WIDTH = 0.22;
const ISO_ASPECT = 16 / 9;
const ISO_RES = 0.8;
const ISO_MARGIN = 12;
const ISO_MIN_HOST_W = 640;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _size = new THREE.Vector2();

const smooth = (x) => { const t = THREE.MathUtils.clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sign = () => (Math.random() < 0.5 ? -1 : 1);

function pickWeighted(list, avoid) {
  const rest = list.filter(([n]) => n !== avoid);
  const pool = rest.length ? rest : list;
  let total = 0;
  for (const [, w] of pool) total += w;
  let r = Math.random() * total;
  for (const [n, w] of pool) { r -= w; if (r <= 0) return n; }
  return pool[pool.length - 1][0];
}

// Horizontal unit vector from a to b (y dropped); `fallback` when they coincide.
function flatDir(a, b, out, fallback) {
  out.set(b.x - a.x, 0, b.z - a.z);
  return out.lengthSq() > 1e-6 ? out.normalize() : out.copy(fallback);
}

// True when the straight move from a to b on the ground plane would carry the camera
// through a fighter. Short moves never do: the follow covers them in a frame or two.
function crossesPair(a, b, ps) {
  const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
  if (L2 < 1.2 * 1.2) return false;
  for (const p of ps) {
    const t = THREE.MathUtils.clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / L2, 0, 1);
    const ex = a.x + dx * t - p.x, ez = a.z + dz * t - p.z;
    if (ex * ex + ez * ez < 0.9 * 0.9) return true;
  }
  return false;
}

// Keep a camera out of the stands: low rigs inside the first row, high ones within the hall.
function clampRadius(p, name) {
  // The crowd cutaway sits in the seats on purpose.
  if (name === 'reaction') return p;
  const max = p.y < LOW_RIG_Y ? LOW_RADIUS : HIGH_RADIUS;
  const r = Math.hypot(p.x, p.z);
  if (r > max) { p.x *= max / r; p.z *= max / r; }
  return p;
}

class DirectorMethods {
  /** Director state, created on first use. `on`/`isoOn` come from init options (default on). */
  _dirState() {
    if (this._dir) return this._dir;
    const o = this.options || {};
    // Unless the page says otherwise, the TV cuts are part of the Full show (show.js fullShow).
    const full = this._fullShow();
    this._dir = {
      on: o.director === undefined ? full : o.director !== false,
      isoOn: o.isoCam === undefined ? full : o.isoCam !== false,
      live: false,
      shot: null,         // { name, len, t, focus, side, seed, pos, look, fov }
      prev: null,         // name of the shot before, to avoid repeats
      pending: null,      // { kind, idx, until }
      clock: 0,           // wall-clock seconds while live
      lastHp: [MAX_HP, MAX_HP],
      lastCombo: [0, 0],
      red: [false, false],
      lastHitAt: -99,
      victim: 1,          // the fighter who last took a landed hit
      whip: null,         // { t, fromPos, fromQuat }
      cuts: { n: 0, whip: 0 },
      iso: null,          // lazily built by _isoBuild
    };
    return this._dir;
  }

  /** Public toggle (index.js). Off hands the camera straight back to the spring boom. */
  setDirector(on) {
    const d = this._dirState();
    d.on = !!on;
    if (!d.on) this._directorRelease();
  }

  /** Public toggle (index.js) for the picture-in-picture iso cam. */
  setIsoCam(on) {
    const d = this._dirState();
    d.isoOn = !!on;
    if (!d.isoOn) this._isoShow(false);
  }

  /**
   * Diagnostics for the harness: the live shot and whether the iso inset is up. `force`
   * (a rig name) cuts to that shot on the next frame — a test hook, never used by the page.
   */
  directorState(force) {
    const d = this._dirState();
    if (typeof force === 'string') d.forced = force;
    return {
      on: d.on, live: d.live, shot: d.shot?.name ?? null, focus: d.shot?.focus ?? null,
      shotT: d.shot ? Math.round(d.shot.t * 100) / 100 : 0,
      iso: d.isoOn, isoShown: !!d.iso?.shown, isoFocus: d.iso?.focus ?? null,
      cuts: d.cuts.n, whips: d.cuts.whip, calm: this._calm(),
    };
  }

  _directorAllowed() {
    const m = this.options?.mode;
    return m === 'demo' || m === 'tournament';
  }

  /** True when the director owns the camera this frame (cinematics.js _updateCamera). */
  _directorLive() {
    if (!this._directorAllowed()) return false;
    const d = this._dirState();
    const live = d.on && this.phase === 'fighting'
      && (this.cameraMode === 'normal' || (this.cameraMode === 'super' && !this._superFighter));
    if (!live && d.live) this._directorRelease();
    return live;
  }

  _directorRelease() {
    const d = this._dirState();
    d.live = false;
    d.shot = null;
    d.whip = null;
    d.pending = null;
    // Out of the fight (round over, KO): the next round opens fresh on the house framing.
    // A super hand-off keeps `prev` and the event memory, so the cut back is a new angle.
    if (this.phase !== 'fighting') d.prev = null;
    // The spring boom picks up from wherever the last shot left the camera, at rest.
    this._camVel?.set(0, 0, 0);
  }

  // ── Events ────────────────────────────────────────────────────────────
  // Polled from fighter state rather than hooked into hitResolution, so the director
  // can never change what the sim does.
  _directorEvents() {
    const d = this._dir;
    let ev = null;
    const rank = { combo: 1, heavy: 2, red: 3 };
    const raise = (kind, idx) => { if (!ev || rank[kind] > rank[ev.kind]) ev = { kind, idx }; };
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      const hp = this._hp(f);
      const drop = d.lastHp[i] - hp;
      if (drop > 0) { d.victim = i; d.lastHitAt = d.clock; }
      if (drop >= HEAVY_HIT_DMG) raise('heavy', i);
      if (!d.red[i] && hp > 0 && hp <= RED_HP) { d.red[i] = true; raise('red', i); }
      d.lastHp[i] = hp;
      const c = f.comboN || 0;
      // Tighten on the third hit of a run; the victim is the other corner.
      if (c >= 3 && d.lastCombo[i] < 3) raise('combo', 1 - i);
      d.lastCombo[i] = c;
    }
    return ev;
  }

  _directorReset() {
    const d = this._dir;
    for (let i = 0; i < 2; i++) {
      d.lastHp[i] = this.fighters ? this._hp(this.fighters[i]) : MAX_HP;
      d.lastCombo[i] = 0;
      d.red[i] = false;
    }
    d.pending = null;
    d.lastHitAt = -99;
  }

  // ── The director ──────────────────────────────────────────────────────
  /**
   * Drive the camera for one frame. Called from _updateCamera's director branch with the
   * framing it already computed. Returns the FOV this shot wants (the shared FOV code
   * after the branches eases and punches around it).
   */
  _directCamera(dt, mid, axis, perp, sep) {
    const d = this._dirState();
    const calm = this._calm();
    const lens = calm ? CALM_LEN : SHOT_LEN;
    this._camVel.set(0, 0, 0); // hit impulses are the spring boom's; a TV camera holds
    d.clock += dt;
    const c = { mid, axis, perp, sep, p: [this.fighters[0].rig.root.position, this.fighters[1].rig.root.position] };

    if (!d.live) {
      // New round: open on the house framing (what the countdown showed), then reset the
      // event memory. Back from a super: hard cut to a fresh angle.
      d.live = true;
      const fresh = !d.prev;
      if (fresh) this._directorReset();
      const pool = POOL.filter(([n]) => n !== 'reaction');
      this._cutTo(this._makeShot(fresh ? 'main' : pickWeighted(pool, d.prev), lens), c, false);
    } else {
      const ev = this._directorEvents();
      if (ev) d.pending = { ...ev, until: d.clock + EVENT_TTL };
      const s = d.shot;
      s.t += dt;
      const min = s.name === 'reaction' ? s.len : lens.min;
      let next = null;
      if (d.forced) { next = this._makeShot(d.forced, lens, d.forced === 'ots' || d.forced === 'pushin' ? 0 : null); d.forced = null; }
      if (d.pending && d.pending.until < d.clock) d.pending = null;
      if (!next && d.pending && s.t >= min) {
        next = this._eventShot(d.pending, s, lens);
        d.pending = null;
        // Already tight on the action: hold the shot a little longer instead of cutting.
        if (!next) s.len = Math.min(lens.max, Math.max(s.len, s.t + 1.5));
      }
      if (!next && s.t >= s.len) next = this._nextShot(s, lens, calm);
      if (next) this._cutTo(next, c, !calm && Math.random() < WHIP_CHANCE);
    }

    const s = d.shot;
    const fov = this._rig(s, c);
    clampRadius(s.pos, s.name);
    // Within a shot the rig is followed, not snapped: fighters move every frame and a
    // camera bolted to them jitters. A cut (s.snap) lands exactly. So does a move that
    // would pass through the fighters — the framing side changed (cinematics.js
    // _camSideCut) or the pair turned under the rig: a TV camera cuts there, it doesn't
    // fly through the ring.
    if (!s.snap && (this._camSideCut || crossesPair(s.cam, s.pos, c.p))) s.snap = true;
    const k = s.snap ? 1 : 1 - Math.exp(-dt * (s.name === 'wide' || s.name === 'crane' ? 3 : 6));
    if (s.snap) {
      s.cam.copy(s.pos);
      s.aim.copy(s.look);
    } else {
      s.cam.lerp(s.pos, k);
      s.aim.lerp(s.look, k);
    }
    s.snap = false;

    if (d.whip) {
      // Whip-pan: the lens swings from the old view to the new one in a quarter second
      // and the existing radial blur + afterimage smear sell the speed.
      const w = d.whip;
      w.t += dt;
      const e = smooth(w.t / WHIP_SEC);
      _m.lookAt(s.cam, s.aim, _up);
      _q.setFromRotationMatrix(_m);
      this.camera.position.lerpVectors(w.fromPos, s.cam, e);
      this.camera.quaternion.slerpQuaternions(w.fromQuat, _q, e);
      this.radialPulse = Math.max(this.radialPulse || 0, 1.4 * Math.sin(Math.PI * Math.min(1, w.t / WHIP_SEC)));
      if (w.t >= WHIP_SEC) d.whip = null;
    } else {
      this.camera.position.copy(s.cam);
      this.camera.lookAt(s.aim);
    }
    return fov;
  }

  _makeShot(name, lens, focus = null) {
    const len = name === 'reaction'
      ? rand(CUTAWAY_LEN.min, CUTAWAY_LEN.max)
      : name === 'pushin' ? rand(Math.max(lens.min, 4), Math.min(lens.max, 6.5))
      : rand(lens.min + 0.6, lens.max);
    return {
      name, len, t: 0, focus, side: sign(), seed: Math.random() * 6.283,
      pos: new THREE.Vector3(), look: new THREE.Vector3(), cam: new THREE.Vector3(), aim: new THREE.Vector3(),
      snap: true,
    };
  }

  // An event's shot, or null when the current one already covers it.
  _eventShot(ev, cur, lens) {
    if (ev.kind === 'red') {
      if (cur.name === 'pushin' && cur.focus === ev.idx) return null;
      return this._makeShot('pushin', lens, ev.idx);
    }
    // heavy / combo: tighten on the fighter taking it.
    if (TIGHT.has(cur.name)) return null;
    return Math.random() < 0.5
      ? this._makeShot('two', lens)
      : this._makeShot('ots', lens, ev.idx);
  }

  _nextShot(cur, lens, calm) {
    const d = this._dir;
    // A cutaway only in a lull: never two in a row, never mid-exchange, and calm mode
    // (fewer cuts) skips them altogether.
    const quiet = d.clock - d.lastHitAt > 1.0;
    let list = POOL;
    if (calm || !quiet || cur.name === 'reaction') list = POOL.filter(([n]) => n !== 'reaction');
    // Back from a cutaway, re-establish both fighters.
    if (cur.name === 'reaction') list = list.filter(([n]) => n === 'main' || n === 'wide' || n === 'two');
    const name = pickWeighted(list, cur.name);
    const focus = name === 'ots' ? (Math.random() < 0.6 ? d.victim : 1 - d.victim) : null;
    return this._makeShot(name, lens, focus);
  }

  _cutTo(shot, c, whip) {
    const d = this._dir;
    const from = d.shot;
    if (from) d.prev = from.name;
    d.cuts.n++;
    d.shot = shot;
    d.whip = null;
    this._show('cut', { shot: shot.name, whip: !!whip });
    const fov = this._rig(shot, c);
    clampRadius(shot.pos, shot.name);
    // A whip only reads when the view actually swings; for a small move it is a lurch.
    if (whip && from) {
      _a.subVectors(from.aim, from.cam).normalize();
      _b.subVectors(shot.look, shot.pos).normalize();
      if (_a.dot(_b) < Math.cos(THREE.MathUtils.degToRad(35))) {
        d.whip = { t: 0, fromPos: this.camera.position.clone(), fromQuat: this.camera.quaternion.clone() };
        d.cuts.whip++;
        this._smearT = Math.max(this._smearT || 0, WHIP_SEC);
        this._smearAmt = Math.max(this._smearAmt || 0, 0.55);
      }
    }
    // Hard cut: the lens lands at the new focal length with no zoom.
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    shot.snap = true;
    this._isoRetarget();
  }

  // ── The rigs ──────────────────────────────────────────────────────────
  // Each writes shot.pos / shot.look from the fighters' positions and returns a vertical
  // FOV. Every rig except the reaction cutaway keeps both fighters in the frame.

  // Distance at which a frame of the given vertical FOV is `halfWidth` wide each side.
  _fitDistance(halfWidth, fov) {
    const aspect = this._hostH ? this._hostW / this._hostH : 16 / 9;
    return halfWidth / (Math.tan(THREE.MathUtils.degToRad(fov / 2)) * aspect);
  }

  _rig(s, c) {
    const { mid, axis, perp, sep, p } = c;
    const base = this.fovBase;
    const t = s.t;
    const bias = this._framingHeightBias();
    switch (s.name) {
      case 'wide': {
        // Establishing: high and back, a slow lateral drift so it never reads as frozen.
        const fov = base;
        const dist = Math.max(this._framingDistance(sep) * 1.8, this._fitDistance(sep / 2 + 1.8, fov));
        s.pos.copy(mid).addScaledVector(perp, dist).addScaledVector(axis, Math.sin(t * 0.12 + s.seed) * 0.8);
        s.pos.y = 3.1 + sep * 0.1;
        s.look.copy(mid).setY(0.85);
        return fov;
      }
      case 'ringside': {
        // Low from the apron, looking up at the exchange.
        const fov = base + 4;
        const dist = Math.max(this._framingDistance(sep) * 1.05, this._fitDistance(sep / 2 + 1.0, fov));
        s.pos.copy(mid).addScaledVector(perp, dist).addScaledVector(axis, s.side * 0.9);
        s.pos.y = 0.5;
        s.look.copy(mid).addScaledVector(axis, -s.side * 0.2).setY(1.3 * bias);
        return fov;
      }
      case 'ots': {
        // Over the shoulder of one fighter onto the other's face (s.focus).
        const fi = s.focus ?? 1;
        const subj = p[fi], sh = p[1 - fi];
        const dir = flatDir(sh, subj, _a, axis);              // shoulder → subject
        const lat = _b.set(dir.z, 0, -dir.x);
        if (lat.z < 0) lat.negate();                           // audience side of the pair
        s.pos.copy(sh).addScaledVector(dir, -1.5).addScaledVector(lat, 0.95);
        s.pos.y = 1.75;
        s.look.copy(subj).addScaledVector(dir, -0.3).setY(1.25);
        return base - 4;
      }
      case 'crane': {
        // Jib: arcs around the pair while the arm rises (or sinks) across the shot.
        const fov = base;
        const R = Math.max(this._framingDistance(sep) * 1.35, this._fitDistance(sep / 2 + 1.1, fov));
        const ang = s.side * (0.55 - Math.min(1, t / s.len) * 0.9);
        const cs = Math.cos(ang), sn = Math.sin(ang);
        // perp rotated about Y by `ang`.
        _a.set(perp.x * cs + perp.z * sn, 0, -perp.x * sn + perp.z * cs);
        if (_a.z < 0.15) _a.z = 0.15;                          // stay on the audience side
        _a.normalize();
        s.pos.copy(mid).addScaledVector(_a, R);
        const rise = smooth(t / s.len);
        s.pos.y = s.seed > 3.14 ? 0.9 + 2.5 * rise : 3.4 - 2.3 * rise;
        s.look.copy(mid).setY(1.0 * bias);
        return fov;
      }
      case 'two': {
        // Tight two-shot: long lens, close enough that the exchange fills the frame.
        const fov = base - 5;
        // Fit both widths AND the height: heads clear the HUD strip at the top.
        const dist = Math.max(this._framingDistance(sep) * 0.85, this._fitDistance(sep / 2 + 0.75, fov),
          1.35 / Math.tan(THREE.MathUtils.degToRad(fov / 2)));
        const yaw = s.side * 0.22;
        _a.set(perp.x * Math.cos(yaw) + perp.z * Math.sin(yaw), 0, -perp.x * Math.sin(yaw) + perp.z * Math.cos(yaw));
        s.pos.copy(mid).addScaledVector(_a, dist);
        s.pos.y = 1.45;
        s.look.copy(mid).setY(1.2 * bias);
        return fov;
      }
      case 'pushin': {
        // A fighter in the red: slow push-in from their open side; the opponent stays in
        // the frame, soft behind them.
        const fi = s.focus ?? 0;
        const subj = p[fi];
        const out = flatDir(mid, subj, _a, axis);              // away from the opponent
        _b.copy(perp).multiplyScalar(Math.cos(0.6)).addScaledVector(out, Math.sin(0.6)).normalize();
        const e = smooth(t / s.len);
        s.pos.copy(subj).addScaledVector(_b, THREE.MathUtils.lerp(3.8, 2.4, e));
        s.pos.y = 1.5;
        s.look.copy(subj).lerp(mid, 0.3).setY(1.35);
        return base - 6 - 4 * e;
      }
      case 'reaction': {
        // Crowd cutaway: from between the first two rows of seats, just over the front
        // row's heads, back toward the ring — the room reacting in the foreground (the crowd
        // bounces with `excited`), the fight small behind it. A slow pan keeps it alive.
        const ang = Math.atan2(perp.z, perp.x) + s.side * (0.7 + (s.seed / 6.283) * 0.5);
        s.pos.set(Math.cos(ang) * 8.4, 1.0, Math.sin(ang) * 8.4);
        s.look.copy(mid).addScaledVector(axis, s.side * (0.6 - Math.min(1, t / s.len) * 1.2)).setY(0.95);
        return 38;
      }
      case 'main':
      default: {
        // The house framing — the same maths as the spring boom's resting point.
        s.pos.copy(mid).addScaledVector(perp, this._framingDistance(sep));
        s.pos.y = 1.55 + sep * 0.06;
        s.look.copy(mid).setY(mid.y + 1 * bias);
        return base;
      }
    }
  }

  // ── Iso cam (picture-in-picture) ──────────────────────────────────────
  // A second, cheap render of the scene: a small half-float target at ~0.8× the inset's
  // device pixels, every other frame, no post chain and no shadow-map re-render, then
  // tone-mapped into a scissored corner of the canvas by its own OutputPass.

  _isoAllowed() {
    if (!this._directorAllowed()) return false;
    const d = this._dirState();
    if (!d.isoOn) return false;
    if ((this._hostW || 0) < ISO_MIN_HOST_W) return false;
    // Tier hysteresis: a drop to 'low' pulls the inset at once (it is the first thing to
    // go when frames are short), but it only comes back at the next round's bell, so a
    // tier hovering at the boundary cannot pop it in and out mid-fight.
    if (this.phase !== d.isoPhase) {
      if (this.phase === 'fighting') d.isoBlocked = Quality.tier() === 'low';
      d.isoPhase = this.phase;
    }
    if (Quality.tier() === 'low') d.isoBlocked = true;
    if (d.isoBlocked) return false;
    if (d.coarse === undefined) {
      try { d.coarse = window.matchMedia('(pointer: coarse)').matches; } catch { d.coarse = false; }
    }
    return !d.coarse;
  }

  _isoBuild() {
    const d = this._dir;
    if (d.iso) return d.iso;
    const cam = new THREE.PerspectiveCamera(36, ISO_ASPECT, 0.1, this.camera.far);
    const rt = new THREE.WebGLRenderTarget(16, 9, { type: THREE.HalfFloatType });
    const out = new OutputPass();
    out.renderToScreen = true;
    const el = document.createElement('div');
    el.className = 'pb-iso';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = `position:absolute;left:${ISO_MARGIN}px;bottom:${ISO_MARGIN}px;display:none;`
      + 'pointer-events:none;z-index:3;box-sizing:border-box;border:2px solid rgba(255,209,102,0.9);'
      + 'border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,0.45),inset 0 0 0 1px rgba(0,0,0,0.55);';
    el.innerHTML = '<span style="position:absolute;left:6px;top:6px;display:flex;align-items:center;gap:6px;'
      + 'padding:2px 8px 2px 6px;border-radius:4px;background:rgba(8,10,22,0.82);color:#f4f6ff;'
      + 'font:700 11px/1.4 system-ui,sans-serif;letter-spacing:0.08em;text-transform:uppercase;">'
      + '<span style="width:7px;height:7px;border-radius:50%;background:#ff3b3b;box-shadow:0 0 6px #ff3b3b;"></span>'
      + '<span class="pb-iso__name">ISO</span></span>';
    this.container.appendChild(el);
    d.iso = { cam, rt, out, el, nameEl: el.querySelector('.pb-iso__name'), shown: false, focus: 0,
      w: 0, h: 0, frame: 0, fresh: false, pos: new THREE.Vector3(), aim: new THREE.Vector3(), snap: true };
    return d.iso;
  }

  _isoShow(on) {
    const iso = this._dir?.iso;
    if (!iso || iso.shown === on) return;
    iso.shown = on;
    iso.el.style.display = on ? 'block' : 'none';
    if (on) { iso.snap = true; iso.fresh = false; }
  }

  // Which fighter the inset follows: the one the main shot is NOT centred on.
  _isoRetarget() {
    const d = this._dir;
    if (!d?.iso || !this.fighters) return;
    const s = d.live ? d.shot : null;
    let focus;
    if (s && s.focus !== null && s.focus !== undefined) focus = 1 - s.focus;
    else if (s && s.name !== 'reaction') {
      // Project both from the new shot's pose; the one further from centre gets the iso.
      // A tie (symmetric two-shot) goes to whoever is taking the punishment.
      const ndc = [0, 1].map((i) => {
        _m.lookAt(s.pos, s.look, _up);
        _a.copy(this.fighters[i].rig.root.position).setY(1.2).sub(s.pos).applyMatrix4(_m.transpose());
        return Math.abs(_a.x / Math.max(0.1, -_a.z));
      });
      focus = Math.abs(ndc[0] - ndc[1]) < 0.08 ? d.victim : (ndc[0] > ndc[1] ? 0 : 1);
    } else focus = d.victim;
    if (focus !== d.iso.focus) {
      d.iso.focus = focus;
      d.iso.snap = true;
    }
    const name = this.fighters[focus]?.rig?.config?.name || '';
    d.iso.nameEl.textContent = `ISO · ${name}`;
  }

  /** Per frame, after the main camera (cinematics.js _updateCamera): place the iso camera. */
  _updateIsoCam(dt) {
    // Not over the KO or the super hero shot; a mode string still held at 'super' by the
    // camera dwell after the beat has ended (`_superFighter` cleared) counts as normal.
    const want = this.fighters && this._isoAllowed() && this.phase === 'fighting' && !this._compiling
      && (this.cameraMode === 'normal' || (this.cameraMode === 'super' && !this._superFighter));
    if (!want) { this._isoShow(false); return; }
    const d = this._dir;
    const iso = this._isoBuild();
    if (!iso.shown) { this._isoShow(true); this._isoRetarget(); }
    // Director off: no main shot to read, so follow whoever is taking the hits.
    if (!d.live && iso.focus !== d.victim && (d.clock - (iso.switchedAt ?? -99)) > 3) {
      iso.switchedAt = d.clock;
      this._isoRetarget();
    }
    if (!d.live) {
      // The events poll only runs inside the director; keep `victim` fresh without it.
      for (let i = 0; i < 2; i++) {
        const hp = this._hp(this.fighters[i]);
        if (hp < d.lastHp[i]) { d.victim = i; d.lastHitAt = d.clock; }
        d.lastHp[i] = hp;
      }
      d.clock += dt;
    }

    const sf = this.fighters[iso.focus];
    const subj = sf.rig.root.position;
    const opp = this.fighters[1 - iso.focus].rig.root.position;
    // Frame the head and shoulders, not the root (the feet): fighters lean and duck.
    const head = sf.rig.joints?.head;
    if (head) head.getWorldPosition(_c); else _c.set(subj.x, 1.8, subj.z);
    // Tight on the face from the opponent's side, swung 55° toward the audience so the
    // opponent is not in the way.
    const dir = flatDir(subj, opp, _a, _b.set(1, 0, 0));
    const lat = _b.set(dir.z, 0, -dir.x);
    if (lat.z < 0) lat.negate();
    const cs = Math.cos(0.95), sn = Math.sin(0.95);
    // The head joint is the neck pivot; the skull sits above it.
    const tx = _c.x + (dir.x * cs + lat.x * sn) * 1.85;
    const tz = _c.z + (dir.z * cs + lat.z * sn) * 1.85;
    const k = iso.snap ? 1 : 1 - Math.exp(-dt * 5);
    iso.pos.lerp(_a.set(tx, _c.y + 0.05, tz), k);
    iso.aim.lerp(_b.set(_c.x, _c.y - 0.05, _c.z), k);
    iso.snap = false;
    iso.cam.position.copy(iso.pos);
    iso.cam.lookAt(iso.aim);
  }

  /** After composer.render() (game.js loop): draw the inset over the finished frame. */
  _renderIsoCam() {
    const iso = this._dir?.iso;
    if (!iso || !iso.shown) return;
    const r = this.renderer;
    const { x: W, y: H } = r.getSize(_size);
    const w = Math.round(W * ISO_WIDTH), h = Math.round(w / ISO_ASPECT);
    const pr = r.getPixelRatio();
    const rw = Math.max(16, Math.round(w * pr * ISO_RES)), rh = Math.max(9, Math.round(h * pr * ISO_RES));
    if (iso.w !== w || iso.h !== h) {
      iso.w = w; iso.h = h;
      iso.el.style.width = `${w}px`;
      iso.el.style.height = `${h}px`;
      iso.fresh = false;
    }
    if (iso.rt.width !== rw || iso.rt.height !== rh) { iso.rt.setSize(rw, rh); iso.fresh = false; }

    // The scene pass runs at half rate (a 30 Hz feed); the blit has to run every frame
    // because the composer repaints the whole canvas.
    iso.frame ^= 1;
    if (iso.frame === 0 || !iso.fresh) {
      // Shadow maps were rendered for this frame by the main pass; reuse them.
      const auto = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false;
      try {
        r.setRenderTarget(iso.rt);
        r.render(this.scene, iso.cam);
      } finally {
        r.shadowMap.autoUpdate = auto;
        r.setRenderTarget(null);
      }
      iso.fresh = true;
    }
    // Inside the 2 px frame. setViewport/setScissor take CSS pixels, origin bottom-left.
    const x = ISO_MARGIN + 2, y = ISO_MARGIN + 2, vw = w - 4, vh = h - 4;
    r.setViewport(x, y, vw, vh);
    r.setScissor(x, y, vw, vh);
    r.setScissorTest(true);
    try {
      iso.out.render(r, null, iso.rt);
    } finally {
      r.setScissorTest(false);
      r.setScissor(0, 0, W, H);
      r.setViewport(0, 0, W, H);
    }
  }

  _disposeDirector() {
    const iso = this._dir?.iso;
    if (!iso) return;
    iso.rt.dispose();
    iso.out.dispose();
    iso.el.remove();
    this._dir.iso = null;
  }
}

export const Director = DirectorMethods.prototype;
