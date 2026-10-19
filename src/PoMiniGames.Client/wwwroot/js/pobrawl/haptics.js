// haptics.js — PoBrawl's controller rumble and phone buzz, routed to the person who felt it.
//
// impactBus.js owns the policy every rumble in the app goes through (the Haptics setting,
// reduced haptics under reduced motion, rate and duty caps). This file owns WHO gets it:
//
//   • only a human-driven corner — never a CPU, so the tournament (CPU vs CPU) is silent;
//   • online, only the LOCAL corner (the remote player's hits are their own browser's business),
//     and nobody while spectating;
//   • on the pad driving that corner (gamepadBus KeyBridge slot), else, for player 1, the phone
//     (navigator.vibrate) — the touch panel is player 1's.
//
// While a fight runs it claims the platform haptics, so impactBus.impact() (the KO calls it for
// the screen shake) does not also buzz the active pad on the engine's behalf.
//
// The vocabulary:
//   charge(f, amt)    a rising pulse train while a strike is held (hold-to-charge) — pulses, never
//                     one long effect, and "ambient", so reduced haptics drops it;
//   perfectGuard(f)   one sharp tick on the high motor;
//   rumble(...)       landed hits (scaled thumps, game.js _landHit) and the KO's long thud.

export class BrawlHaptics {
  /**
   * @param {object} game  the BrawlGame
   * @param {{active: boolean}} o  false for CPU-only and spectator fights: nothing ever plays
   */
  constructor(game, { active }) {
    this.game = game;
    this.active = !!active;
    this._release = window.PoImpact?.claimHaptics?.() || null;
    // Per fighter (2P can coil both at once): the wall-clock ms of the next charge pulse and, for
    // the phone, how many thirds of the coil have already ticked.
    this._charge = new Map();
  }

  /** The KeyBridge slot of the human feeling `f`, or 0 for nobody. */
  slotFor(f) {
    const g = this.game;
    if (!this.active || !f || !g.fighters) return 0;
    if (g.online) {
      const side = g.online.localSide || 0;
      return side && f === g.fighters[side - 1] ? 1 : 0;   // online the local pad is always slot 1
    }
    if (f.controller?.isHuman !== true) return 0;
    return g.fighters.indexOf(f) + 1;
  }

  /**
   * Dual-rumble for `f`'s human. `opts.phone` overrides the phone pattern (derived from the
   * strength and length otherwise); `opts.priority` lets the KO past the duty cap.
   */
  rumble(f, strong, weak, ms, opts = {}) {
    const slot = this.slotFor(f);
    if (!slot) return;
    const pads = this.game.gamepads;
    if (pads?.hasPad?.(slot)) {
      pads.rumble(slot, strong, weak, ms, opts);
      return;
    }
    if (slot !== 1 || opts.phone === null) return;
    const pattern = opts.phone
      || [Math.round(Math.min(ms, 40 + 120 * strong) * (0.35 + 0.65 * Math.max(strong, weak)))];
    window.PoImpact?.vibrate?.(pattern, { pad: false, priority: !!opts.priority, ambient: !!opts.ambient });
  }

  /** Every tick of a held strike: a pulse train that rises with the coil. */
  charge(f, amt) {
    const slot = this.slotFor(f);
    if (!slot) return;
    let c = this._charge.get(f);
    if (!c) { c = { next: 0, step: 0 }; this._charge.set(f, c); }
    const now = performance.now();
    if (now < c.next) return;
    const a = Math.max(0, Math.min(1, amt));
    // ~8 pulses a second, each 60–75 ms: well under impactBus's duty cap, felt as a build-up.
    // At full charge the train slows to a "ready" throb rather than going solid.
    const full = a >= 1;
    c.next = now + (full ? 200 : 125);
    const pads = this.game.gamepads;
    if (pads?.hasPad?.(slot)) {
      pads.rumble(slot,
        full ? 0.55 : 0.04 + 0.5 * a * a,
        full ? 0.35 : 0.12 + 0.4 * a,
        full ? 80 : 60 + 15 * a,
        { ambient: true });
      return;
    }
    // Phones have no magnitude: tick at each third of the coil instead of buzzing throughout.
    const step = Math.floor(a * 3 + 1e-6);
    if (step > c.step) {
      c.step = step;
      this.rumble(f, 0.2, 0.2, 30, { phone: [8 + 6 * step], ambient: true });
    }
  }

  /** The strike was released (or the coil interrupted): the next coil starts its train afresh. */
  chargeEnd(f) {
    this._charge.delete(f);
  }

  /** A PERFECT guard: one sharp, short tick on the high motor. */
  perfectGuard(f) {
    this.rumble(f, 0.1, 1, 45, { priority: true, phone: [14] });
  }

  dispose() {
    this._release?.();
    this._release = null;
    this.active = false;
    this._charge.clear();
  }
}
