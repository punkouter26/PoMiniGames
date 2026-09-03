// index.js — the engine global (engineLoader contract): window.PoEcosystem.* is what the
// Blazor page calls, window.__poeco() is the debug/E2E handle. This file owns the sim host
// and the routing of its messages; the renderer (render/) and the thought bridge attach to
// the engine object when present.
import { createSimHost } from './host/simHost.js';
import { LLM_STATE, MODELS, createThoughtBridge } from './host/thoughtBridge.js';
import { createRenderer } from './render/renderer.js';
import { openWorldStore, loadWorldMeta } from './sim/persistence/idb.js';
import { createPrefs } from './sim/persistence/prefs.js';
import { hashString } from './sim/core/prng.js';
import { NONE } from './sim/core/entities.js';

let engine = null;

function createEngine(container, dotnetRef, opts) {
  const state = {
    container, dotnetRef, opts, host: null, mode: 'starting', ready: false, seed: null,
    creatureCount: 0, fps: 0, simLag: 0, stats: null, llm: null, lastDetail: null, terrain: null, lastTiles: null,
    renderer: null, thoughts: null, selected: NONE, frames: 0, errors: [],
    player: null,
  };

  const invoke = async (method, ...args) => {
    if (!dotnetRef) return;
    try { await dotnetRef.invokeMethodAsync(method, ...args); } catch (err) { state.errors.push(`${method}: ${err?.message ?? err}`); }
  };

  function onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        state.ready = true; state.seed = msg.seed; state.mode = state.host?.mode ?? state.mode;
        invoke('OnReady', msg.seed, msg.tick, msg.resumed, msg.physics);
        return;
      case 'terrain':
        state.terrain = msg;
        state.renderer?.setTerrain(msg);
        return;
      case 'frame':
        state.frames++;
        if (state.renderer) state.renderer.acceptFrame(msg.buffer, (buf) => state.host.send({ type: 'recycle', buffer: buf }, [buf]));
        else state.host.send({ type: 'recycle', buffer: msg.buffer }, [msg.buffer]);
        return;
      case 'tiles':
        state.lastTiles = msg;
        state.renderer?.setTiles(msg);
        return;
      case 'stats':
        state.stats = msg.stats; state.creatureCount = msg.stats.alive; state.simLag = msg.stats.simLag; state.llm = msg.stats.llm;
        state.renderer?.setStats(msg.stats);
        invoke('OnStats', JSON.stringify({ ...msg.stats, popHistory: Array.from(msg.stats.popHistory) }));
        return;
      case 'events':
        invoke('OnEvents', JSON.stringify(msg.events));
        return;
      case 'detail':
        state.lastDetail = msg.detail;
        invoke('OnDetail', msg.detail ? JSON.stringify(msg.detail) : null);
        return;
      case 'thoughtRequest':
        // The bridge answers asynchronously; a refusal (busy / not ready) cancels the
        // sim's in-flight slot so the round-robin can offer another creature.
        if (!state.thoughts || !state.thoughts.request(msg)) state.host.send({ type: 'thoughtCancel' });
        return;
      case 'saved':
        invoke('OnSaved', msg.tick, msg.reason);
        return;
      case 'error':
        state.errors.push(`${msg.where}: ${msg.message}`);
        invoke('OnEngineError', msg.where, msg.message);
        return;
      case 'debugResult': case 'probeResult':
        return;
      default:
        return;
    }
  }

  const api = {
    state,
    async start() {
      const prefs = createPrefs(globalThis.localStorage);
      state.prefs = prefs;
      if (container) {
        state.renderer = createRenderer(container, {
          minimapCanvas: opts.minimapId ? document.getElementById(opts.minimapId) : null,
          quality: { lowEnd: !!opts.lowEnd },
          onFps: (fps) => { state.fps = fps; },
          onPick: (handle) => { api.select(handle); invoke('OnPick', handle); },
          onAction: (action, value) => {
            if (action === 'speed') { api.setSpeed(value); invoke('OnSpeed', value); return; }
            if (action === 'follow') { state.renderer.follow(state.selected); return; }
            invoke('OnAction', action, value === undefined ? null : String(value));
          },
        });
        state.renderer.setPose(prefs.get('player'));
        state.poseTimer = setInterval(() => prefs.set('player', state.renderer.player), 5000);
      }
      state.thoughts = createThoughtBridge({
        onResult: (handle, text) => state.host?.send({ type: 'thoughtResult', handle, text }),
        onState: (s) => { state.llmState = s; invoke('OnLlmState', JSON.stringify(s)); },
      });
      if (opts.llmEnabled) state.thoughts.start(opts.modelId ?? MODELS[0].id);
      state.host = await createSimHost({
        onMessage,
        importCannon: () => import('cannon-es'),
        log: (m) => { state.errors.push(m); console.warn('[poecosystem]', m); },
      });
      state.mode = state.host.mode;
      state.host.send({
        type: 'init', seed: hashString(opts.seed ?? ''), resume: !!opts.resume, llmEnabled: !!opts.llmEnabled,
        lowEnd: !!opts.lowEnd,
      });
      if (typeof document !== 'undefined') {
        state.onVisibility = () => { if (document.hidden) { state.host.send({ type: 'saveNow', reason: 'hidden' }); state.host.send({ type: 'pause' }); } else state.host.send({ type: 'resume' }); };
        document.addEventListener('visibilitychange', state.onVisibility);
      }
    },
    send: (msg, transfer) => state.host?.send(msg, transfer),
    setSpeed: (speed) => state.host?.send({ type: 'setSpeed', speed }),
    select(handle) {
      state.selected = handle ?? NONE;
      state.host?.send({ type: 'select', handle: state.selected });
      state.renderer?.select(state.selected);
      if (state.selected === NONE) state.renderer?.follow(NONE);
    },
    follow: (handle) => state.renderer?.follow(handle ?? state.selected),
    newWorld: (seed) => state.host?.send({ type: 'newWorld', seed: hashString(seed ?? '') }),
    async setLlm(enabled, modelId) {
      state.host?.send({ type: 'setLlmEnabled', enabled: !!enabled });
      if (enabled) await state.thoughts?.start(modelId ?? state.thoughts.modelId);
      else { state.thoughts?.dispose(); state.host?.send({ type: 'thoughtCancel' }); }
    },
    thoughtResult: (handle, text) => state.host?.send({ type: 'thoughtResult', handle, text }),
    saveNow: () => state.host?.send({ type: 'saveNow', reason: 'manual' }),
    debug: (op, arg) => state.host?.send({ type: 'debug', op, arg }),
    attachRenderer(r) { state.renderer = r; if (state.terrain) r.setTerrain(state.terrain); if (state.lastTiles) r.setTiles(state.lastTiles); },
    attachThoughts(t) { state.thoughts = t; },
    stop() {
      if (state.poseTimer) clearInterval(state.poseTimer);
      if (state.renderer && state.prefs) state.prefs.set('player', state.renderer.player);
      if (state.onVisibility) document.removeEventListener('visibilitychange', state.onVisibility);
      state.host?.send({ type: 'saveNow', reason: 'stop' });
      state.thoughts?.dispose?.();
      state.renderer?.dispose?.();
      state.host?.dispose();
      state.host = null;
    },
    get mode() { return state.mode; },
    get creatureCount() { return state.creatureCount; },
    get fps() { return state.renderer?.fps ?? 0; },
    get simLag() { return state.simLag; },
    get llm() { return { sim: state.llm, bridge: state.llmState ?? { state: LLM_STATE.OFF }, models: MODELS }; },
    get player() { return state.renderer?.player ?? null; },
  };
  return api;
}

const PoEcosystem = {
  /** Is there a saved world? → { exists, seed, tick, year } */
  async probeSave() {
    try { const meta = await loadWorldMeta(await openWorldStore()); return meta ? { exists: true, ...meta } : { exists: false }; } catch { return { exists: false }; }
  },
  async start(containerId, dotnetRef, opts = {}) {
    if (engine) engine.stop();
    const container = typeof document !== 'undefined' ? document.getElementById(containerId) : null;
    engine = createEngine(container, dotnetRef, opts);
    await engine.start();
    return true;
  },
  stop() { if (engine) { engine.stop(); engine = null; } },
  setSpeed: (s) => engine?.setSpeed(s),
  select: (h) => engine?.select(h),
  newWorld: (seed) => engine?.newWorld(seed),
  setLlm: (enabled, modelId) => engine?.setLlm(enabled, modelId),
  saveNow: () => engine?.saveNow(),
  debug: (op, arg) => engine?.debug(op, arg),
  follow: (handle) => engine?.follow(handle),
  toggleFly: () => engine?.state.renderer?.toggleFly(),
  requestLock: () => engine?.state.renderer?.requestLock(),
  touchMove: (x, z) => engine?.state.renderer?.touchMove(x, z),
  touchRelease: () => engine?.state.renderer?.touchRelease(),
  models: () => MODELS.map(m => ({ ...m })),
  async webGpuAvailable() { const { hasWebGpuSupport } = await import('./host/thoughtBridge.js'); return hasWebGpuSupport(); },
};

if (typeof window !== 'undefined') {
  window.PoEcosystem = PoEcosystem;
  window.__poeco = () => engine;
}

export { PoEcosystem, createEngine };
