// input.js — keyboard → stride intents for the two local layouts.
//
// The core mechanic: each player must type their four sequence keys IN ORDER
// (P1: Q W A S · P2: I O K L). A completed cycle emits one `impulse`. A wrong
// sequence key resets progress to the start of the cycle — speed is untouched,
// the lost keystrokes are the penalty. A fifth, dedicated key jumps (P1: E · P2: P).
//
// AI lanes, the touch pad, online key-forwarding, and tests all reuse the same
// state machine through injectKey(), so there is exactly one implementation of
// the sequence rules on the client.
export const LAYOUTS = {
  1: { sequence: ['KeyQ', 'KeyW', 'KeyA', 'KeyS'], jump: 'KeyE' },
  2: { sequence: ['KeyI', 'KeyO', 'KeyK', 'KeyL'], jump: 'KeyP' },
};

export class SequenceTracker {
  /**
   * @param {1|2} layout which key layout this player uses
   * @param {{onImpulse?: () => void, onJump?: () => void, onReset?: () => void,
   *          isGated?: () => boolean, onGatedKey?: () => void}} handlers
   *   isGated/onGatedKey implement the false-start rule: while gated (before the gun),
   *   EVERY sequence key is a false start rather than silently banking progress.
   */
  constructor(layout, handlers = {}) {
    this.map = LAYOUTS[layout];
    this.progress = 0; // index into map.sequence of the NEXT expected key
    this.handlers = handlers;
  }

  /** Reset sequence progress (wrong key, false start, leg change, online rejoin). */
  reset() {
    if (this.progress !== 0) {
      this.progress = 0;
      this.handlers.onReset?.();
    }
  }

  /**
   * Feed one key press. Returns 'impulse' | 'jump' | 'gated' | 'reset' | 'progress' | null
   * (null = key not in this layout, e.g. the other player's keys).
   */
  injectKey(code) {
    if (code === this.map.jump) {
      this.handlers.onJump?.();
      return 'jump';
    }
    if (!this.map.sequence.includes(code)) return null;

    // Before the gun, ONE key is already a false start — progress must never bank across
    // the start. PoSportsSim.HandleSequenceKey applies the same rule server-side; when this
    // check lived at the caller (which only saw completed 4-key cycles) a player could type
    // three keys during the countdown and fire a free impulse on the gun, making local times
    // unreachable for online runs on the very same leaderboard.
    if (this.handlers.isGated?.()) {
      this.progress = 0;
      this.handlers.onGatedKey?.();
      return 'gated';
    }

    if (code === this.map.sequence[this.progress]) {
      this.progress++;
      if (this.progress === this.map.sequence.length) {
        this.progress = 0;
        this.handlers.onImpulse?.();
        return 'impulse';
      }
      return 'progress';
    }
    // Out of order — back to the top of the cycle. A wrong key that happens to be
    // the first sequence key counts as that first step, matching what a player
    // restarting their rhythm would expect.
    this.progress = code === this.map.sequence[0] ? 1 : 0;
    this.handlers.onReset?.();
    return 'reset';
  }
}

/** Attaches window keydown listeners for the given trackers. Returns a detach fn. */
export function attachKeyboard(trackers) {
  const all = new Set();
  for (const t of trackers) {
    for (const c of t.map.sequence) all.add(c);
    all.add(t.map.jump);
  }
  const onDown = (e) => {
    if (!all.has(e.code)) return;
    e.preventDefault();
    if (e.repeat) return; // holding a key is not typing
    for (const t of trackers) t.injectKey(e.code);
  };
  window.addEventListener('keydown', onDown);
  return () => window.removeEventListener('keydown', onDown);
}
