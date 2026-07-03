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
  },
  reset() { if (game) game.resetMatch(false); },
  setMuted(muted) { if (game) game.setMuted(muted); },
  destroy() { if (game) { game.dispose(); game = null; } },
};
