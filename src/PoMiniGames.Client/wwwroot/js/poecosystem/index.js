// index.js — the engine global (engineLoader contract): window.PoEcosystem.* is what the
// Blazor page calls, window.__poeco() is the debug/E2E handle. This file owns the sim host
// and the routing of its messages; the renderer (render/) and the thought bridge attach to
// the engine object when present.
import { createSimHost } from './host/simHost.js';
import { LLM_STATE, MODELS, createThoughtBridge } from './host/thoughtBridge.js';
import { createRenderer } from './render/renderer.js';
import { createAudio } from './render/audio.js';
import { createMusic } from './render/music.js';
import { openWorldStore, loadWorldMeta } from './sim/persistence/idb.js';
import { createPrefs } from './sim/persistence/prefs.js';
import { hashString } from './sim/core/prng.js';
import { NONE } from './sim/core/entities.js';

let engine = null;

// The HUD stylesheet is injected here rather than shipped as PoEcosystemViewer.razor.css:
// the HUD is built from several components and Blazor's scoped CSS does not cross
// component boundaries, so a scoped file would style the shell and nothing inside it.
// Same approach as js/posurvive/theme.js. Loading it here also keeps it off every other
// page — the game is route-gated through engineLoader.
const STYLE_ID = 'poecosystem-css';
function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('css/poecosystem.css', document.baseURI).href;
  document.head.appendChild(link);
}

function createEngine(container, dotnetRef, opts) {
  const state = {
    container, dotnetRef, opts, host: null, mode: 'starting', ready: false, seed: null,
    creatureCount: 0, simLag: 0, stats: null, llm: null, lastDetail: null, terrain: null, lastTiles: null,
    renderer: null, thoughts: null, selected: NONE, frames: 0, errors: [], msgCounts: {},
    audio: createAudio(), sound: true, wakeAudio: null,
    music: null,
    // Music inputs. The sim reports CUMULATIVE births/deaths, so the score is driven from
    // the difference between consecutive stats messages; `eventPressure` is a decaying
    // reservoir bumped by each natural event, which is what lets the soundtrack stay tense
    // for a few seconds after an eruption rather than only during it.
    lastBorn: -1, lastDied: 0, eventPressure: 0,
  };
  state.music = createMusic(state.audio);

  const invoke = async (method, ...args) => {
    if (!dotnetRef) return;
    try { await dotnetRef.invokeMethodAsync(method, ...args); } catch (err) { state.errors.push(`${method}: ${err?.message ?? err}`); }
  };

  function onMessage(msg) {
    // Per-type counters: the cheapest way to tell "the worker is silent" from "a handler
    // threw", both from the console and from the E2E smoke.
    state.msgCounts[msg.type] = (state.msgCounts[msg.type] ?? 0) + 1;
    switch (msg.type) {
      case 'ready':
        state.ready = true; state.seed = msg.seed;
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
        state.audio.setDay(msg.stats.dayFraction);
        feedMusic(msg.stats);
        state.renderer?.setStats(msg.stats);
        invoke('OnStats', JSON.stringify({ ...msg.stats, popHistory: Array.from(msg.stats.popHistory) }));
        return;
      case 'events':
        for (const ev of msg.events) {
          if (ev.kind !== 'lightning' && ev.kind !== 'rockslide' && ev.kind !== 'eruption') continue;
          state.eventPressure = Math.min(1, state.eventPressure + (ev.kind === 'eruption' ? 0.8 : 0.45));
          // The renderer owns the whole reaction — particles, flash, camera, and the
          // POSITIONED stinger. Only a headless engine falls back to a centred one.
          if (state.renderer) state.renderer.onEvent(ev);
          else state.audio.stinger(ev.kind);
        }
        invoke('OnEvents', JSON.stringify(msg.events));
        return;
      case 'thoughts':
        invoke('OnThoughts', JSON.stringify(msg.thoughts));
        return;
      case 'telemetry':
        try {
          const blob = new Blob([JSON.stringify(msg.payload)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `poecosystem-telemetry-y${msg.payload?.world?.year ?? 0}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (err) { state.errors.push(`telemetry: ${err?.message ?? err}`); }
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

  /**
   * Turn one stats message into the four numbers music.js actually wants. Cumulative
   * counters are differenced here rather than in the score, so the music module never has
   * to know that a resumed world starts with a full almanac behind it.
   */
  function feedMusic(stats) {
    const born = (stats.almanac?.born ?? []).reduce((a, b) => a + b, 0);
    const died = (stats.almanac?.died ?? []).reduce((a, b) => a + b, 0);
    // The first message after a load establishes the baseline: without this, resuming a
    // hundred-year-old world would open on a birth rate of four hundred.
    const first = state.lastBorn < 0;
    const births = first ? 0 : Math.max(0, born - state.lastBorn);
    const deaths = first ? 0 : Math.max(0, died - state.lastDied);
    state.lastBorn = born; state.lastDied = died;
    state.eventPressure = Math.max(0, state.eventPressure - 0.06);   // ~8 s to fall from a full eruption
    state.music?.setWorld({
      alive: stats.alive, births, deaths,
      extinct: (stats.extinct ?? []).filter(Boolean).length,
      eventPressure: state.eventPressure,
      dayFraction: stats.dayFraction,
    });
  }

  const api = {
    state,
    async start() {
      const prefs = createPrefs(globalThis.localStorage);
      state.prefs = prefs;
      state.sound = prefs.get('sound') !== false;
      state.audio.setEnabled(state.sound);
      // Browsers only allow audio after a user gesture; the canvas handlers below are
      // gestures, so the ambience wakes on the first click/keypress and stays idle before.
      state.wakeAudio = () => { state.audio.ensure(); if (state.sound) state.music?.start(); };
      if (typeof document !== 'undefined') {
        document.addEventListener('pointerdown', state.wakeAudio);
        document.addEventListener('keydown', state.wakeAudio);
      }
      if (container) {
        state.renderer = createRenderer(container, {
          minimapCanvas: opts.minimapId ? document.getElementById(opts.minimapId) : null,
          quality: { lowEnd: !!opts.lowEnd },
          audio: state.audio,
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
      // Always release the sim's in-flight slot: start() tears the worker down, so any
      // request already handed to the model will never be answered, and the sim would
      // otherwise wait for that creature forever.
      state.thoughts?.cancel();
      state.host?.send({ type: 'thoughtCancel' });
      if (enabled) await state.thoughts?.start(modelId ?? state.thoughts.modelId);
      else state.thoughts?.dispose();
    },
    saveNow: () => state.host?.send({ type: 'saveNow', reason: 'manual' }),
    debug: (op, arg) => state.host?.send({ type: 'debug', op, arg }),
    exportTelemetry: () => state.host?.send({ type: 'exportTelemetry' }),
    setSound(on) {
      state.sound = !!on;
      state.prefs?.set('sound', state.sound);
      state.audio.ensure();
      state.audio.setEnabled(state.sound);
      if (state.sound) state.music?.start();
      state.music?.setEnabled(state.sound);
    },
    stop() {
      if (state.poseTimer) clearInterval(state.poseTimer);
      if (state.renderer && state.prefs) state.prefs.set('player', state.renderer.player);
      if (state.onVisibility) document.removeEventListener('visibilitychange', state.onVisibility);
      if (state.wakeAudio) {
        document.removeEventListener('pointerdown', state.wakeAudio);
        document.removeEventListener('keydown', state.wakeAudio);
        state.wakeAudio = null;
      }
      state.music?.dispose();
      state.audio.dispose();
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
    get soundEnabled() { return state.sound; },
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
    ensureStyles();
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
  exportTelemetry: () => engine?.exportTelemetry(),
  setSound: (on) => engine?.setSound(on),
  soundEnabled: () => (engine ? engine.soundEnabled : true),
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
