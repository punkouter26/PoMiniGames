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

// TEMP DEBUG — headless verification hooks.
window.__ff = (steps) => {
  if (!game || !game.marbleSet) return null;
  for (let i = 0; i < steps; i++) game.world.step(1 / 120, 1 / 120, 1);
  game.marbleSet.sync();
  const zs = game.marbleSet.marbles.map(m => m.body.position.z);
  return { min: Math.round(Math.min(...zs)), max: Math.round(Math.max(...zs)), finishZ: Math.round(game.track.finishZ) };
};
window.__fin = () => game && game.marbleSet ? game.marbleSet.marbles.map(m => ({
  fin: m.finished, elim: m.eliminated,
  y: Math.round(m.body.position.y),
  vis: m.mesh.visible,
  inWorld: game.world.bodies.includes(m.body),
})) : null;
