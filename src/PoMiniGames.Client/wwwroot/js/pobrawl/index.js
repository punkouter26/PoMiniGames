// index.js — public interop surface for PoBrawl. The Blazor page calls these.
import { BrawlGame } from './game.js';

let game = null;

window.PoBrawl = {
  /** options: { mode: '1p'|'2p'|'demo', p1Character, p2Character, difficulty } */
  init(containerId, dotnetRef, options) {
    if (game) { game.dispose(); game = null; }
    const el = document.getElementById(containerId);
    if (!el) { console.error('[PoBrawl] container not found:', containerId); return; }
    game = new BrawlGame(el, dotnetRef, options || {});
    game.start();
    // Debug/automation handle (read-only introspection; not part of the API).
    window.PoBrawl._game = game;
  },
  reset() { if (game) game.resetMatch(false); },
  /**
   * 1P ladder: after a win, roll straight into the next president without a
   * full re-init. Swaps the opponent + difficulty on the live game and runs
   * the "NEXT ROUND" splash → countdown (same path demo mode uses between
   * rounds), so no end-of-game modal appears between rungs.
   */
  next(p2Character, difficulty) {
    if (!game) return;
    if (p2Character) game.options.p2Character = p2Character;
    if (difficulty !== undefined && difficulty !== null) game.options.difficulty = difficulty;
    game.resetMatch(false);
  },
  setMuted(muted) { if (game) game.setMuted(muted); },
  destroy() { if (game) { game.dispose(); game = null; } },
};
