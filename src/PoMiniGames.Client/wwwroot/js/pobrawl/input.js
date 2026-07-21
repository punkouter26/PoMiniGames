// input.js — keyboard → fight intents for the two local layouts.
// Intent shape (shared with ai.js): { move: -1|0|1 (+1 = toward opponent),
// side: -1|0|1 (edge-triggered step), punch: bool (press edge), kick: bool
// (press edge), punchHeld: bool, kickHeld: bool, block: bool, super: bool }.
// The press edge starts a charge; the engine releases the attack when the
// matching *Held flag drops — hold longer for a more powerful strike.
//
// Layout 1 (P1): A/D move · W step in · S tap step out, hold = block · F punch · G kick · E super
// Layout 2 (P2): ←/→ move · ↑ step in · ↓ tap step out, hold = block · K punch · L kick · O super
//
// `left`/`right` are SCREEN-relative: the left key always walks the fighter
// toward the left edge of the screen, the right key toward the right edge,
// no matter which side of the ring the fighter is standing on. update() folds
// the fighter's facing back in to produce the engine's opponent-relative
// `move` (+1 = toward opponent).
const LAYOUTS = {
  1: { left: 'KeyA', right: 'KeyD', stepIn: 'KeyW', stepOutOrBlock: 'KeyS', punch: 'KeyF', kick: 'KeyG', super: 'KeyE' },
  2: { left: 'ArrowLeft', right: 'ArrowRight', stepIn: 'ArrowUp', stepOutOrBlock: 'ArrowDown', punch: 'KeyK', kick: 'KeyL', super: 'KeyO' },
};

const BLOCK_HOLD_MS = 120;

export class KeyboardController {
  constructor(layout) {
    this.map = LAYOUTS[layout];
    this.down = new Set();
    this.punchQueued = false;
    this.kickQueued = false;
    this.sideQueued = 0;
    this.superQueued = false;
    this.blockKeyDownAt = 0;

    this._onDown = (e) => {
      if (Object.values(this.map).includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      if (e.code === this.map.punch) this.punchQueued = true;
      else if (e.code === this.map.kick) this.kickQueued = true;
      else if (e.code === this.map.stepIn) this.sideQueued = 1;
      else if (e.code === this.map.stepOutOrBlock) this.blockKeyDownAt = performance.now();
      else if (e.code === this.map.super) this.superQueued = true;
    };
    this._onUp = (e) => {
      this.down.delete(e.code);
      if (e.code === this.map.stepOutOrBlock) {
        // Quick tap = sidestep out; a longer hold was a block, not a step.
        if (performance.now() - this.blockKeyDownAt < BLOCK_HOLD_MS) this.sideQueued = -1;
        this.blockKeyDownAt = 0;
      }
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
    const block = this.blockKeyDownAt > 0 && performance.now() - this.blockKeyDownAt >= BLOCK_HOLD_MS;
    const intent = {
      move,
      side: this.sideQueued,
      punch: this.punchQueued,
      kick: this.kickQueued,
      // Held flags keep a charge alive; the `|| queued` term guarantees a
      // sub-tick tap still reads as held for one update (then releases).
      punchHeld: this.down.has(this.map.punch) || this.punchQueued,
      kickHeld: this.down.has(this.map.kick) || this.kickQueued,
      block,
    };
    this.punchQueued = false;
    this.kickQueued = false;
    this.sideQueued = 0;
    return intent;
  }

  dispose() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
  }
}
