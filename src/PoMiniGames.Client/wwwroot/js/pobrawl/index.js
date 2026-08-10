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
   * Roll straight into the next round without a full re-init, running the
   * splash → countdown path demo mode already uses between rounds, so no
   * end-of-game modal appears in between.
   *
   * Two callers, and the null-tolerance below is what lets them share it:
   *   • the 1P ladder passes the next president + difficulty (new opponent);
   *   • the 2P best-of-3 passes neither, keeping both players' picks, and
   *     passes `roundLabel` so the splash names the round.
   *
   * @param {string|null} p2Character  new opponent, or null to keep the current one
   * @param {number|string|null} difficulty  new CPU level, or null to keep it
   * @param {string|null} roundLabel  one-shot splash heading (e.g. "ROUND 2")
   */
  next(p2Character, difficulty, roundLabel) {
    if (!game) return;
    if (p2Character) game.options.p2Character = p2Character;
    if (difficulty !== undefined && difficulty !== null) game.options.difficulty = difficulty;
    game._roundLabel = roundLabel || null;
    game.resetMatch(false);
  },
  setMuted(muted) { if (game) game.setMuted(muted); },
  destroy() { if (game) { game.dispose(); game = null; } },
};
