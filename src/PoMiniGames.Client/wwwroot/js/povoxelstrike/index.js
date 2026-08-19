// index.js — public interop surface for PoVoxelStrike. The Blazor page calls these
// through window.PoVoxelStrike after awaiting loadEngine('povoxelstrike').

import { Engine } from './game.js';
import { loadAssets } from './assets.js';

let engine = null;
// Monotonic token for the in-flight start(): assets are fetched over the network, so two
// starts can overlap (navigate away and back) and the slower one must not install its
// Engine over the newer one's. Same pattern as PoMarbleRace's map fetch.
let startToken = 0;
// Cached by start() so restart() can rebuild a fresh world WITHOUT re-fetching or
// re-decoding assets — "Play again" costs one world build, not a full boot.
let lastStart = null; // { containerId, dotnetRef, demo, volumes }

function boot(host, dotnetRef, demo, volumes) {
  try {
    engine = new Engine(host, dotnetRef, demo, volumes);
    engine.start();
  } catch (err) {
    console.error('[PoVoxelStrike] engine boot failed:', err);
    try { dotnetRef.invokeMethodAsync('OnFatalError', String(err?.message ?? err)); } catch { }
  }
}

window.PoVoxelStrike = {
  async start(containerId, dotnetRef, demo) {
    const token = ++startToken;
    if (engine) { engine.dispose(); engine = null; }

    const host = document.getElementById(containerId);
    if (!host) { console.error('[PoVoxelStrike] container not found:', containerId); return; }

    let volumes;
    try {
      volumes = await loadAssets();
    } catch (err) {
      // Manifest unreachable (offline, cold server). The procedural fallback world in
      // world.js still needs no assets — play on with an empty list rather than dying.
      console.warn('[PoVoxelStrike] asset load failed, using procedural world:', err);
      volumes = [];
    }
    if (token !== startToken) return; // a newer start() or stop() landed mid-fetch

    lastStart = { containerId, dotnetRef, demo, volumes };
    boot(host, dotnetRef, demo, volumes);
  },

  /**
   * Fast "Play again": tear down the run, reuse the already-decoded voxel volumes,
   * build a fresh (new-seed) world synchronously. Falls back to a no-op when no run
   * ever started — the Blazor side only offers restart after a successful boot.
   */
  restart() {
    if (!lastStart) return;
    startToken++; // invalidate any in-flight start()
    if (engine) { engine.dispose(); engine = null; }
    const host = document.getElementById(lastStart.containerId);
    if (!host) return;
    boot(host, lastStart.dotnetRef, lastStart.demo, lastStart.volumes);
  },

  resume() { engine?.resume(); },

  /**
   * Fullscreen the canvas host (the engine's ResizeObserver handles the resize).
   * Fires from a Blazor button click, so the gesture requirement is satisfied.
   */
  toggleFullscreen() {
    const host = engine?.host || document.getElementById('povoxelstrike-container');
    if (!host) return;
    if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => { });
    else host.requestFullscreen?.().catch?.(() => { });
  },

  /** PRD §4.2 interop surface: cancel the current run immediately (no game-over
   *  event fires). Same teardown as stop(); the distinct name keeps call sites
   *  honest about intent — abort mid-run vs stop on page dispose. */
  abort() { this.stop(); },

  stop() { startToken++; if (engine) { engine.dispose(); engine = null; } },
};

// TEMP DEBUG — headless verification hook (same convention as PoMarbleRace's __game):
// lets a scripted browser carve/inspect without pointer lock, which headless runs
// cannot acquire.
window.__pvs = () => engine;
