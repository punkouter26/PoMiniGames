// index.js — the engine global (engineLoader contract): window.PoEcosystem.* is what the
// Blazor page calls, window.__poeco() is the debug/E2E handle. This file owns the sim host
// and the routing of its messages; the renderer (render/) and the thought bridge attach to
// the engine object when present.
import { createSimHost } from './host/simHost.js';
import { CLOUD_MODEL_ID, LLM_STATE, MODELS, createThoughtBridge } from './host/thoughtBridge.js';
import { fetchSpeciesInfo } from './host/naturalist.js';
import { createRenderer } from './render/renderer.js';
import { BINDABLE, DEFAULT_BINDINGS, mergeBindings } from './render/input.js';
import { HOST } from './sim/core/config.js';
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
// Loading it here keeps it off every other
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
    renderer: null, thoughts: null, selected: NONE, directorSubject: NONE, frames: 0, errors: [], msgCounts: {},
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
        // The living count rides on ready: the first stats message follows the terrain,
        // whose mesh build can take a while, and until then the engine reported 0.
        state.ready = true; state.seed = msg.seed; state.creatureCount = msg.alive ?? state.creatureCount;
        invoke('OnReady', msg.seed, msg.tick, msg.resumed, msg.physics);
        return;
      case 'terrain':
        state.terrain = msg;
        state.renderer?.setTerrain(msg);
        return;
      case 'history':
        // The timeline: every landmark and the per-year rows, sent only when they grew.
        invoke('OnHistory', JSON.stringify({ landmarks: msg.landmarks, years: msg.years }));
        return;
      case 'thoughtBatchRequest': {
        // Cloud thoughts, eight creatures per server call. Always answered — an empty result
        // is what releases the runtime's one batch in flight.
        const done = (results) => state.host?.send({ type: 'thoughtBatchResult', results });
        if (!dotnetRef || !state.thoughts?.cloudReady) { done([]); return; }
        const items = (msg.items ?? []).map(it => ({ id: it.handle, species: it.species, name: it.name, hunger: it.hunger, thirst: it.thirst, health: it.health, goal: it.goal, nearby: it.nearby }));
        dotnetRef.invokeMethodAsync('OnCloudThoughtBatch', JSON.stringify(items))
          .then((json) => {
            const reply = json ? JSON.parse(json) : null;
            done((reply?.results ?? []).map(r => ({ handle: r.id, text: JSON.stringify({ thought: r.thought, trait: r.trait, delta: r.delta }) })));
          })
          .catch(() => done([]));
        return;
      }
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
        state.audio.setDay(msg.stats.dayFraction, msg.stats.season ?? 0);
        feedMusic(msg.stats);
        state.renderer?.setStats(msg.stats);
        invoke('OnStats', JSON.stringify({ ...msg.stats, popHistory: Array.from(msg.stats.popHistory), traitHistory: Array.from(msg.stats.traitHistory ?? []) }));
        return;
      case 'lineage':
        invoke('OnLineage', msg.handle, msg.tree ? JSON.stringify(msg.tree) : null);
        return;
      case 'snapshotBytes':
        // A Uint8Array crosses to .NET as byte[] (no base64 detour), so a megabyte world
        // costs one copy rather than a string a third bigger.
        invoke('OnSnapshotBytes', msg.slot, new Uint8Array(msg.bytes));
        return;
      case 'events':
        for (const ev of msg.events) {
          // A tech unlock or an outbreak is a cut for the director, not a stinger or a shake.
          if (ev.kind === 'tech' || ev.kind === 'outbreak') { state.renderer?.onEvent(ev); continue; }
          // Diplomacy logs as kind 'diplomacy' with an action; the old checks here looked
          // for 'war_declared' / 'peace_treaty', which no log entry ever carried.
          if (ev.kind === 'diplomacy' && ev.action === 'war') { state.audio?.warHorn(); }
          else if ((ev.kind === 'diplomacy' && ev.action === 'peace') || ev.kind === 'treaty') { state.audio?.tribalDrum(null, false); }
          if (ev.kind !== 'lightning' && ev.kind !== 'rockslide' && ev.kind !== 'eruption') continue;
          state.eventPressure = Math.min(1, state.eventPressure + (ev.kind === 'eruption' ? 0.8 : 0.45));
          // The renderer owns the whole reaction — particles, camera trauma, and the
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
      // HUD idle fade: after 5 s without player input the HUD chrome drops to a whisper;
      // any input restores it. Toggled through a data attribute Blazor never renders, so
      // component re-renders cannot clobber it (poecosystem.css styles [data-idle]).
      state.hudIdle = {
        timer: 0,
        events: ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'],
        wake: () => {
          const hud = document.querySelector('.poeco-hud');
          if (hud) hud.removeAttribute('data-idle');
          clearTimeout(state.hudIdle.timer);
          state.hudIdle.timer = setTimeout(() => hud?.setAttribute('data-idle', ''), 5000);
        },
      };
      for (const t of state.hudIdle.events) window.addEventListener(t, state.hudIdle.wake, { passive: true });
      state.hudIdle.wake();
      if (container) {
        state.renderer = buildRenderer();
        state.renderer.setPose(prefs.get('player'));
        state.poseTimer = setInterval(() => { if (state.renderer) prefs.set('player', state.renderer.player); }, 5000);
      }
      if (typeof document !== 'undefined') applyPalette(prefs.get('palette'));
      await startHost();
    },
  };

  // Add members to the api object. Object.assign would copy each getter's value once and
  // leave a frozen data property behind (creatureCount stuck at 0, mode at 'starting'), so
  // the descriptors are copied instead.
  function extend(target, members) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(members)); return target; }

  /**
   * The renderer is built here (and rebuilt by setQuality / setPalette / a lost GL context)
   * from the prefs the Settings panel writes. A rebuild replays the cached terrain, tiles and
   * stats, so the island reappears exactly as it was without asking the worker for anything.
   */
  function buildRenderer() {
    const prefs = state.prefs;
    const quality = prefs.get('quality');
    return createRenderer(container, {
          minimapCanvas: opts.minimapId ? document.getElementById(opts.minimapId) : null,
          quality: { lowEnd: !!opts.lowEnd, tier: quality === 'auto' ? null : quality },
          palette: prefs.get('palette'),
          reducedMotion: prefs.get('reducedMotion'),
          bindings: prefs.get('bindings'),
          audio: state.audio,
          onPick: (handle) => { api.select(handle); invoke('OnPick', handle); },
          onAction: (action, value) => {
            if (action === 'contextRestored') { rebuildRenderer(); invoke('OnAction', 'contextRestored', null); return; }
            if (action === 'speed') { api.setSpeed(value); invoke('OnSpeed', value); return; }
            // Follow whatever the camera is actually on: the director's subject while it
            // holds the camera, otherwise the creature the player inspected.
            if (action === 'follow') { state.renderer.follow(state.selected !== NONE ? state.selected : state.directorSubject); return; }
            // The director's subject is NOT selected. Selecting it opened the inspector
            // popover over the shot and outlined the creature in wireframe, turning a
            // cinematic camera into a stats readout; the shot is the point (2026-09-16).
            // The handle is still remembered so T can follow what is on screen.
            if (action === 'directorSubject') { state.directorSubject = value ?? NONE; return; }
            if (action === 'director') { invoke('OnDirector', !!value, state.renderer?.directorCaption ?? ''); return; }
            if (action === 'directorCaption') { invoke('OnDirector', true, value ?? ''); return; }
            if (action === 'pip') { invoke('OnPip', !!value); return; }
            invoke('OnAction', action, value === undefined ? null : String(value));
          },
          directorIdleSeconds: opts.demo ? 4 : 150,
        });
  }

  function rebuildRenderer() {
    if (!container || !state.renderer) return;
    const pose = state.renderer.player;
    const tint = state.renderer.tint ?? -1;
    const held = state.directorHeld;
    state.renderer.dispose();
    state.renderer = buildRenderer();
    if (state.terrain) state.renderer.setTerrain(state.terrain);
    if (state.lastTiles) state.renderer.setTiles(state.lastTiles);
    if (state.stats) state.renderer.setStats(state.stats);
    if (pose) state.renderer.setPose(pose);
    if (tint >= 0) state.renderer.setTint(tint);
    if (held) state.renderer.holdDirector(true);
  }

  /** Chart and chip colours follow a data attribute (poecosystem.css defines both palettes). */
  function applyPalette(palette) {
    if (typeof document === 'undefined') return;
    if (palette === 'cb') document.documentElement.setAttribute('data-poeco-palette', 'cb');
    else document.documentElement.removeAttribute('data-poeco-palette');
  }

  const settingsSnapshot = () => ({
    quality: state.prefs?.get('quality') ?? 'auto',
    palette: state.prefs?.get('palette') ?? 'default',
    reducedMotion: !!state.prefs?.get('reducedMotion'),
    bindings: mergeBindings(state.prefs?.get('bindings')),
    defaults: DEFAULT_BINDINGS,
    bindable: BINDABLE,
    gamepad: typeof navigator !== 'undefined' && !!navigator.getGamepads && [...(navigator.getGamepads() ?? [])].some(p => p?.connected),
  });

  extend(api, {
    applyTreaty(treaty) {
      const t = typeof treaty === 'string' ? JSON.parse(treaty) : treaty;
      state.host?.send({ type: 'applyTreaty', treaty: t });
    },
    note: (kind, text, tile) => state.host?.send({ type: 'note', kind, text, tile: Number.isInteger(tile) ? tile : -1 }),
    flyTo: (x, z) => state.renderer?.flyTo(x, z),
    holdDirector(on) { state.directorHeld = !!on; state.renderer?.holdDirector(!!on); },
    settings: () => settingsSnapshot(),
    setQuality(tier) {
      const t = ['auto', 'high', 'medium', 'low'].includes(tier) ? tier : 'auto';
      state.prefs?.set('quality', t);
      rebuildRenderer();
    },
    setPalette(palette) {
      const p = palette === 'cb' ? 'cb' : 'default';
      state.prefs?.set('palette', p);
      applyPalette(p);
      rebuildRenderer();   // tribe banners are baked into their materials
    },
    setReducedMotion(on) { state.prefs?.set('reducedMotion', !!on); state.renderer?.setReducedMotion(!!on); },
    setBinding(action, code) {
      if (!BINDABLE.includes(action) || typeof code !== 'string' || !code) return settingsSnapshot();
      const current = mergeBindings(state.prefs?.get('bindings'));
      // The new key becomes the primary; any other action that used it loses it, so one key
      // never drives two things.
      for (const a of BINDABLE) current[a] = current[a].filter(c => c !== code);
      current[action] = [code, ...current[action].slice(1)].slice(0, 3);
      for (const a of BINDABLE) if (!current[a].length) current[a] = DEFAULT_BINDINGS[a].filter(c => !Object.values(current).flat().includes(c)).slice(0, 1);
      state.prefs?.set('bindings', current);
      state.renderer?.setBindings(current);
      return settingsSnapshot();
    },
    resetBindings() { state.prefs?.set('bindings', null); state.renderer?.setBindings(null); return settingsSnapshot(); },
    /** The next key pressed (its KeyboardEvent.code), or null on Escape / after 8 s. Swallowed. */
    captureKey() {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (settled) return; settled = true; window.removeEventListener('keydown', onKey, true); resolve(v); };
        const onKey = (e) => { e.preventDefault(); e.stopImmediatePropagation(); finish(e.code === 'Escape' ? null : e.code); };
        window.addEventListener('keydown', onKey, true);
        setTimeout(() => finish(null), 8000);
      });
    },
    speciesInfo: () => fetchSpeciesInfo(),
  });

  async function startHost() {
      state.thoughts = createThoughtBridge({
        onResult: (handle, text) => state.host?.send({ type: 'thoughtResult', handle, text }),
        onState: (s) => { state.llmState = s; invoke('OnLlmState', JSON.stringify(s)); },
        // The cloud model: the Blazor side owns the API client, so each request round-trips
        // through .NET and resolves with the server's text (null when refused or capped).
        cloud: dotnetRef ? (handle, system, prompt) => dotnetRef.invokeMethodAsync('OnCloudThought', handle, system, prompt) : null,
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
        state.onVisibility = () => {
          if (document.hidden) {
            state.host.send({ type: 'saveNow', reason: 'hidden' });
            // Popped out, the island is still being watched: keep it running.
            if (!state.renderer?.pipActive) state.host.send({ type: 'pause' });
          } else state.host.send({ type: 'resume' });
        };
        document.addEventListener('visibilitychange', state.onVisibility);
      }
  }

  extend(api, {
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
      // The cloud model answers eight creatures per call (the runtime batches and paces them);
      // an in-browser model answers one at a time as fast as the GPU allows.
      const target = modelId ?? state.thoughts?.modelId;
      state.host?.send({ type: 'setLlmEnabled', enabled: !!enabled, batch: enabled && target === CLOUD_MODEL_ID ? HOST.thoughtBatchSize : 0 });
      // Always release the sim's in-flight slot: start() tears the worker down, so any
      // request already handed to the model will never be answered, and the sim would
      // otherwise wait for that creature forever.
      state.thoughts?.cancel();
      state.host?.send({ type: 'thoughtCancel' });
      if (enabled) await state.thoughts?.start(modelId ?? state.thoughts.modelId);
      else state.thoughts?.dispose();
    },
    saveNow: () => state.host?.send({ type: 'saveNow', reason: 'manual' }),
    exportSnapshot: (slot) => state.host?.send({ type: 'exportSnapshot', slot }),
    importSnapshot(bytes, ephemeral) {
      const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
      // Copy into a fresh buffer: the .NET-provided array may be a view the runtime reuses.
      const copy = u8.slice();
      state.host?.send({ type: 'importSnapshot', bytes: copy.buffer, ephemeral: !!ephemeral }, [copy.buffer]);
    },
    lineage: (handle) => state.host?.send({ type: 'lineage', handle }),
    rename: (handle, name) => state.host?.send({ type: 'rename', handle, name }),
    watch: (handle, on) => state.host?.send({ type: 'watch', handle, on: !!on }),
    setTint: (traitIndex) => state.renderer?.setTint(traitIndex),
    setDirector: (on) => state.renderer?.setDirector(!!on),
    togglePip: () => state.renderer?.togglePip(),
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
      if (state.hudIdle) {
        clearTimeout(state.hudIdle.timer);
        for (const t of state.hudIdle.events) window.removeEventListener(t, state.hudIdle.wake);
        document.querySelector('.poeco-hud')?.removeAttribute('data-idle');
        state.hudIdle = null;
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
  });
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
  lineage: (handle) => engine?.lineage(handle),
  exportSnapshot: (slot) => engine?.exportSnapshot(slot),
  importSnapshot: (bytes, ephemeral) => engine?.importSnapshot(bytes, ephemeral),
  cloudModelId: () => CLOUD_MODEL_ID,
  applyTreaty: (json) => engine?.applyTreaty(json),
  note: (kind, text, tile) => engine?.note(kind, text, tile),
  flyTo: (x, z) => engine?.flyTo(x, z),
  holdDirector: (on) => engine?.holdDirector(on),
  settings: () => engine?.settings() ?? null,
  setQuality: (tier) => engine?.setQuality(tier),
  setPalette: (palette) => engine?.setPalette(palette),
  setReducedMotion: (on) => engine?.setReducedMotion(on),
  setBinding: (action, code) => engine?.setBinding(action, code) ?? null,
  resetBindings: () => engine?.resetBindings() ?? null,
  captureKey: () => engine?.captureKey() ?? Promise.resolve(null),
  async speciesInfo() { try { return JSON.stringify(await (engine ? engine.speciesInfo() : fetchSpeciesInfo())); } catch { return '[]'; } },
  rename: (handle, name) => engine?.rename(handle, name),
  watch: (handle, on) => engine?.watch(handle, on),
  setTint: (traitIndex) => engine?.setTint(traitIndex),
  setDirector: (on) => engine?.setDirector(on),
  togglePip: () => engine?.togglePip(),
  toggleFly: () => engine?.state.renderer?.toggleFly(),
  setPose: (pose) => engine?.state.renderer?.setPose(pose),
  requestLock: () => engine?.state.renderer?.requestLock(),
  touchMove: (x, z) => engine?.state.renderer?.touchMove(x, z),
  touchRelease: () => engine?.state.renderer?.touchRelease(),
  // The cloud entry is listed last: it needs no download and no WebGPU, but it spends the
  // caller's daily allowance, so the settings panel presents it as its own switch.
  models: () => [...MODELS.map(m => ({ ...m })), { id: CLOUD_MODEL_ID, label: 'Cloud model', vramMb: 0, note: 'Runs on the server; uses your daily AI allowance.' }],
  async webGpuAvailable() { const { hasWebGpuSupport } = await import('./host/thoughtBridge.js'); return hasWebGpuSupport(); },
};

if (typeof window !== 'undefined') {
  window.PoEcosystem = PoEcosystem;
  window.__poeco = () => engine;
}

export { PoEcosystem, createEngine };
