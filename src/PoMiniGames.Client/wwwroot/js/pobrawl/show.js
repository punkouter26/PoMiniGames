// show.js — the showtime bus: one event stream the presentation modules hang off, so none of
// them has to patch the fight code. Mixin (mixin.js), `this` is the live game.
//
// Modules (each its own file, each a mixin with an `_init*` that registers here):
//   audioShow.js   — charge riser, beat-locked stingers, camera-aware mix, crowd rhythm
//   chargeAura.js  — the fist/shoe aura while an attack is held
//   balloons.js    — convention balloon drop + bunting cloth
//   ledBoards.js   — apron LED ribbon boards, beat-pulsed truss, phone-light wave
//   replay.js      — the instant replay between the KO and the result
//   resultGlass.js — the frozen-frame glass behind the result
//
// A module registers in its `_init*`:
//   this._onShow(fn)          fn(type, data) for every event below
//   this._onShowUpdate(fn)    fn(dt) every render frame (wall-clock dt, after _updateFx)
//   this._onShowRender(fn)    fn(now) right after composer.render(), same task (frame readable)
//   this._onShowDispose(fn)   fn() at engine teardown, before the scene traverse
//
// Events (`data` fields):
//   'countdown'   {}                                   a round's countdown begins
//   'fight'       {}                                   the bell: phase → fighting
//   'chargeStart' { f, name }                          an attack starts coiling (f.chargeAmt fills 0..1)
//   'release'     { f, name, chargeAmt }               the swing is thrown
//   'hit'         { attacker, defender, dmg, point, region, power }   a landed hit (power 0..1)
//   'block'       { point }                            a blocked strike
//   'super'       { f }                                a signature move fires
//   'ko'          { winner }                           the final blow (phase → ko)
//   'result'      { winner, ko }                       the result is reported (after the KO / bell)
//   'cut'         { shot, whip }                       director camera cut (CPU-only modes)
//   'reset'       {}                                   a new match is being set up
//
// Presentation only: handlers use Math.random, never `this.rng` (seeded replays, online lockstep).
// A throwing handler is logged and skipped, never allowed to take the fight down.

import { AudioShow } from './audioShow.js';
import { ChargeAura } from './chargeAura.js';
import { Balloons } from './balloons.js';
import { LedBoards } from './ledBoards.js';
import { Replay } from './replay.js';
import { ResultGlass } from './resultGlass.js';

export const SHOW_MODULES = [AudioShow, ChargeAura, Balloons, LedBoards, Replay, ResultGlass];

function guard(label, fn, ...args) {
  try { return fn(...args); } catch (e) { console.warn(`[PoBrawl] show ${label} failed`, e); return undefined; }
}

class ShowMethods {
  _initShow() {
    this._showFns = { ev: [], up: [], render: [], dispose: [] };
    for (const init of [this._initAudioShow, this._initChargeAura, this._initBalloons,
      this._initLedBoards, this._initReplay, this._initResultGlass]) {
      if (typeof init === 'function') guard('init', () => init.call(this));
    }
  }

  _onShow(fn) { this._showFns?.ev.push(fn); }
  _onShowUpdate(fn) { this._showFns?.up.push(fn); }
  _onShowRender(fn) { this._showFns?.render.push(fn); }
  _onShowDispose(fn) { this._showFns?.dispose.push(fn); }

  _show(type, data = {}) {
    const fns = this._showFns?.ev;
    if (!fns) return;
    for (const fn of fns) guard(type, fn, type, data);
  }

  _updateShow(dt) {
    const fns = this._showFns?.up;
    if (!fns) return;
    for (const fn of fns) guard('update', fn, dt);
  }

  _renderShow(now) {
    const fns = this._showFns?.render;
    if (!fns) return;
    for (const fn of fns) guard('render', fn, now);
  }

  _disposeShow() {
    const fns = this._showFns?.dispose;
    if (!fns) return;
    for (const fn of fns) guard('dispose', fn);
    this._showFns = null;
  }
}

export const Show = ShowMethods.prototype;
