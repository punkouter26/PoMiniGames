// index.js — public interop surface for PoSports. The Blazor page calls these.
import { SportsGame } from './game.js';

let game = null;

window.PoSports = {
  /**
   * options: { mode: '1p'|'2p'|'demo'|'online', players: [{character, name, human, layout}],
   *            difficulty, seed }
   * In 'online' mode the game renders server snapshots (applySnapshot) instead of
   * simulating locally.
   */
  init(containerId, dotnetRef, options) {
    if (game) { game.dispose(); game = null; }
    const el = document.getElementById(containerId);
    if (!el) { console.error('[PoSports] container not found:', containerId); return; }
    const online = options?.mode === 'online';
    game = new SportsGame(el, dotnetRef, online ? { ...options, mode: '1p' } : (options || {}));
    if (online) game.enterRemoteMode(options?.layout ?? 1);
    game.start();
    // Debug/automation handle (read-only introspection; not part of the API).
    window.PoSports._game = game;
  },

  /** Online mode: feed a server snapshot. */
  applySnapshot(snapshot) { if (game) game.applySnapshot(snapshot); },

  /** Restart the meet with the same lanes (post-podium rematch). */
  restart() { if (game) game.restartMeet(); },

  destroy() { if (game) { game.dispose(); game = null; } },
};
