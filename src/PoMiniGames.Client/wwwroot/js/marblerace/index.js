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
  // dir: -1 nudges left, +1 right (local track frame). Returns whether a charge was spent,
  // so the HUD's on-screen buttons can stay in step with the keyboard path.
  nudge(dir) { return game ? game.nudge(dir) : false; },
  // The pick countdown is owned by the Blazor component, so the pip that goes with it has
  // to be driven from there — JS never sees the tick.
  beep(final) { if (game) game.beep(final); },
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
// Per-marble diagnostic: where each marble is relative to the track surface under it, and
// how fast. `dy` is the gap to the centerline — a marble that fell off the track trends to
// large negative; one that is merely low on a banked turn sits at a stable negative.
window.__diag = () => game && game.marbleSet ? game.marbleSet.marbles.map(m => ({
  i: m.index,
  n: m.spec.name,
  z: Math.round(m.body.position.z),
  dy: Math.round(m.body.position.y - game.track.floorY(m.body.position.z)),
  sp: Math.round(m.speed),
  fin: m.finished,
  el: m.eliminated,
})) : null;
