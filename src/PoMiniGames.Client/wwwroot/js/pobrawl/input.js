// input.js — keyboard → fight intents for the two local layouts.
// Intent shape (shared with ai.js): { move: -1|0|1 (+1 = toward opponent),
// side: -1|0|1 (edge-triggered step), punch: bool (press edge), kick: bool
// (press edge), punchHeld: bool, kickHeld: bool, block: bool, super: bool }.
// The press edge starts a charge; the engine releases the attack when the
// matching *Held flag drops — hold longer for a more powerful strike.
//
// Layout 1 (P1): A/D move · W away / S toward camera · R block (hold) · F punch · G kick
// Layout 2 (P2): ←/→ move · ↑ away / ↓ toward camera · ; block (hold) · K punch · L kick
//
// 2026-08-11 control rework. Was: W stepped in, and S did double duty as a
// tap-to-sidestep / hold-to-block key separated by a 120 ms timer. Now:
//   • W and S move along the CAMERA's depth axis — W into the screen, S out
//     toward the viewer — which is how a fighter circles their opponent here.
//     `side` is no longer an edge-triggered dart; it is held.
//   • R is block, on its own key. The tap-vs-hold split is gone entirely, and
//     with it a real ambiguity: a short block read as a sidestep, so guarding
//     late against a fast swing sometimes stepped you into it instead.
// P2's block moved off ↓ (now a circle key) onto `;`, beside its K/L attacks.
//
// 2026-08-11: the super keys (E / O) are gone. The game is down to two bars —
// health and energy — so there is no super meter on screen for a key to spend,
// and a signature move now fires by itself the moment a human's meter fills
// (game.js `_autoSuperReady`). `super` stays in the intent shape because ai.js
// still sets it: the CPU keeps its own rung-paced activation. A keyboard
// controller now always publishes `super: false` — explicitly, not by omission,
// because an absent field reads as `undefined` at the engine's `intent.super`
// check, and that silent read is precisely what kept the feature dead before.
//
// `left`/`right` are SCREEN-relative: the left key always walks the fighter
// toward the left edge of the screen, the right key toward the right edge,
// no matter which side of the ring the fighter is standing on. update() folds
// the fighter's facing back in to produce the engine's opponent-relative
// `move` (+1 = toward opponent).
// `depthAway` / `depthToward` publish `side` = +1 / −1, which the engine applies
// along the CAMERA's forward axis: +1 walks into the screen, −1 walks out toward
// the viewer. Because the fighters stand side-on to the camera, that axis is
// also the one that carries you around your opponent — this is the circle
// control, expressed in the frame the player actually sees.
//
// Camera-relative is the point, not an implementation detail. The first cut of
// this derived the axis from the line between the fighters, which is consistent
// in ROTATIONAL terms but flips on screen the moment the two swap sides of the
// ring: the same key would walk you into the screen in one exchange and out of
// it in the next. Screen-relative never inverts.
const LAYOUTS = {
  1: {
    left: 'KeyA', right: 'KeyD',
    depthAway: 'KeyW', depthToward: 'KeyS',
    block: 'KeyR', punch: 'KeyF', kick: 'KeyG',
  },
  2: {
    left: 'ArrowLeft', right: 'ArrowRight',
    depthAway: 'ArrowUp', depthToward: 'ArrowDown',
    block: 'Semicolon', punch: 'KeyK', kick: 'KeyL',
  },
};

export class KeyboardController {
  // Marks this fighter as driven by a person at the keyboard. game.js reads it
  // (`_autoSuperReady`) to decide who gets an automatic signature super: humans
  // do, because they no longer have a key for it; AI fighters do not, because
  // ai.js paces its own activation as a difficulty knob.
  isHuman = true;

  constructor(layout) {
    this.map = LAYOUTS[layout];
    this.down = new Set();
    this.punchQueued = false;
    this.kickQueued = false;

    // Circling and blocking are pure held-key state read straight off `down` in
    // update(), so neither needs a queue or a timer here. The sideQueued /
    // blockKeyDownAt pair that used to live here existed only to disambiguate
    // the old tap-vs-hold S key.
    this._onDown = (e) => {
      // Let any modified chord through untouched. This matters now that block
      // is KeyR: Ctrl+R / Cmd+R is reload, and swallowing it would leave a
      // player unable to refresh the page while the fight has focus. No binding
      // in either layout uses a modifier, so nothing is lost by ignoring them.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (Object.values(this.map).includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      if (e.code === this.map.punch) this.punchQueued = true;
      else if (e.code === this.map.kick) this.kickQueued = true;
    };
    this._onUp = (e) => {
      this.down.delete(e.code);
    };
    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
  }

  update(ctx) {
    // Screen-relative intent: +1 = right key, −1 = left key.
    const worldDir = (this.down.has(this.map.right) ? 1 : 0) - (this.down.has(this.map.left) ? 1 : 0);
    // Fold in facing so the keys stay screen-relative. towardX is the sign of
    // (opponent.x − self.x); multiplying maps screen-left/right onto the
    // engine's toward/away `move`. Defaults to +1 when facing is unknown.
    const towardX = (ctx && ctx.towardX) || 1;
    const move = worldDir * towardX;
    // Held, not tapped, and deliberately NOT folded through towardX the way
    // `move` is: this axis is screen-relative by design, so W walks into the
    // screen whichever side of the ring the fighter is standing on. Folding
    // facing in here would reintroduce exactly the inversion this scheme fixes.
    const circle = (this.down.has(this.map.depthAway) ? 1 : 0)
      - (this.down.has(this.map.depthToward) ? 1 : 0);
    const block = this.down.has(this.map.block);
    const intent = {
      move,
      side: circle,
      punch: this.punchQueued,
      kick: this.kickQueued,
      // Held flags keep a charge alive; the `|| queued` term guarantees a
      // sub-tick tap still reads as held for one update (then releases).
      punchHeld: this.down.has(this.map.punch) || this.punchQueued,
      kickHeld: this.down.has(this.map.kick) || this.kickQueued,
      block,
      // Always false for a human — no key maps to it any more. Published
      // explicitly rather than dropped: `intent.super` is read unguarded in
      // _tickFighter, and an omitted field reading `undefined` there is the
      // exact silent failure that kept this system dead for its whole life.
      // A human's super now fires from game.js `_autoSuperReady` instead.
      super: false,
    };
    this.punchQueued = false;
    this.kickQueued = false;
    return intent;
  }

  dispose() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
  }
}
