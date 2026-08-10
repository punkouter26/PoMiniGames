// index.js — public interop surface for PoMarbleRace. The Blazor page calls these.
import { Game } from './game.js';
import { mapById, mapMenu, DEFAULT_MAP_ID } from './maps.js';

let game = null;
// Monotonic token for the in-flight start(). The course model is fetched over the network, so
// two starts can overlap (navigate away and back, or the kiosk cycling a demo) and the slower
// one would otherwise install its Game over the newer one's. Only the latest token may install.
let startToken = 0;

window.PoMarbleRace = {
  /** Slot ids and names for the host's map picker. */
  maps() { return mapMenu(); },

  /** The slot used when the host does not name one. */
  defaultMap() { return DEFAULT_MAP_ID; },

  // Async because a map may have to fetch an authored model before anything can be built. The
  // Blazor page calls this without awaiting; every other entry point below is a no-op until
  // `game` exists, which is the same guard they already had.
  async start(containerId, dotnetRef, demo, mapId) {
    const token = ++startToken;
    if (game) { game.dispose(); game = null; }
    const el = document.getElementById(containerId);
    if (!el) { console.error('[PoMarbleRace] container not found:', containerId); return; }
    const map = mapById(mapId === undefined || mapId === null ? DEFAULT_MAP_ID : mapId);
    let asset;
    try {
      asset = await map.load();
    } catch (err) {
      console.error(`[PoMarbleRace] failed to load map ${map.id} (${map.name}):`, err);
      return;
    }
    // A newer start() (or a stop()) landed while the map was in flight — stand down.
    if (token !== startToken) return;
    game = new Game(containerId, dotnetRef, demo, map.id, asset);
    game.start();
  },
  // 2026-07-19 browser audit #1: host calls resume() after the intro OK is
  // clicked. Until then the rAF loop is gated and OnPhase('pick') is
  // suppressed, so the 3s pick countdown never runs while the intro is
  // still on screen.
  resume() { if (game) game.resume(); },
  pick(index) { if (game) game.pick(index); },
  // dir: -1 steers left, +1 right (local track frame); active toggles the hold on/off. The
  // on-screen pads drive this on pointer down/up, mirroring the keyboard's keydown/keyup.
  setSteer(dir, active) { if (game) game.setSteer(dir, active); },
  // The pick countdown is owned by the Blazor component, so the pip that goes with it has
  // to be driven from there — JS never sees the tick.
  beep(final) { if (game) game.beep(final); },
  regenerate() { if (game) game.regenerate(); },
  setMuted(muted) { if (game) game.setMuted(muted); },
  // Bumping the token here too, so a start() still waiting on the model fetch cannot install a
  // Game after the host has torn the page down.
  stop() { startToken++; if (game) { game.dispose(); game = null; } },
};

// TEMP DEBUG — headless verification hooks.
// The live instance. Headless runs render at 1-2 FPS on swiftshader, so a browser check of the
// racing camera has to drive the phase machine and the director directly rather than wait for
// the demo to get there on its own.
window.__game = () => game;
window.__ff = (steps) => {
  if (!game || !game.marbleSet) return null;
  for (let i = 0; i < steps; i++) { game.world.step(1 / 60, 1 / 60, 1); game.marbleSet.clampSpeeds(); }
  game.marbleSet.updateProgress(game.track);
  game.marbleSet.sync(game.track);
  const ss = game.marbleSet.marbles.map(m => m.s);
  return { min: Math.round(Math.min(...ss)), max: Math.round(Math.max(...ss)), finishS: Math.round(game.track.finishS) };
};
window.__fin = () => game && game.marbleSet ? game.marbleSet.marbles.map(m => ({
  fin: m.finished, elim: m.eliminated,
  y: Math.round(m.body.position.y),
  vis: m.mesh.visible,
  inWorld: game.world.bodies.includes(m.body),
})) : null;
// Per-marble diagnostic, reported in the TRACK's local frame rather than world coordinates —
// on a course that spirals and banks to near-vertical, world x/y/z say nothing about whether a
// marble is in trouble. `s` is progress along the course, `lat` the offset across the channel
// (compare against `hw`, the half-width there), and `h` the height above the floor plane.
window.__diag = () => game && game.marbleSet ? game.marbleSet.marbles.map(m => ({
  i: m.index,
  n: m.spec.name,
  s: Math.round(m.s),
  lat: m.proj ? Math.round(m.proj.lateral * 10) / 10 : null,
  hw: m.proj ? Math.round(game.track.halfWidthAt(m.s)) : null,
  h: m.proj ? Math.round(m.proj.height * 10) / 10 : null,
  sp: Math.round(m.speed),
  fin: m.finished,
  el: m.eliminated,
})) : null;
window.__chosen = () => game ? game.chosen : -1;
