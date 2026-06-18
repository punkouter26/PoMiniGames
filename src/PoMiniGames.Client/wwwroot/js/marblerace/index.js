// index.js — public interop surface for PoMarbleRace. The Blazor page calls these.
import { Game } from './game.js';

let game = null;

window.PoMarbleRace = {
  start(containerId, dotnetRef, demo) {
    if (game) { game.dispose(); game = null; }
    const el = document.getElementById(containerId);
    if (!el) { console.error('[PoMarbleRace] container not found:', containerId); return; }
    game = new Game(containerId, dotnetRef, demo);
    game.start();
  },
  pick(index) { if (game) game.pick(index); },
  regenerate() { if (game) game.regenerate(); },
  setMuted(muted) { if (game) game.setMuted(muted); },
  stop() { if (game) { game.dispose(); game = null; } },
};
