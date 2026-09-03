// simRuntime.js — the one message protocol between the simulation and its host (plan
// decision 2: "one runtime, two hosts"). The worker wraps it in self.onmessage, simHost.js
// runs it inline when workers fail, and Vitest drives it with a fake `post`.
//
// In:  probe · init · newWorld · setSpeed · pause · resume · select · setLlmEnabled ·
//      thoughtResult · thoughtCancel · saveNow · recycle · debug · dispose
// Out: probeResult · ready · terrain · frame (transferred) · tiles · stats · events ·
//      detail · thoughtRequest · saved · debugResult · error
import { CREATURE_CAP, HOST, LOW_END_CREATURE_CAP, PROP_CAP } from '../sim/core/config.js';
import { NONE } from '../sim/core/entities.js';
import { createFrameBuffer, encodeFrame, FRAME } from '../sim/frame.js';
import { createWorld } from '../sim/world.js';
import { createPhysics } from '../sim/physics/world.js';
import { generateIsland } from '../sim/terrain/island.js';
import { restoreWorld, snapshotWorld } from '../sim/persistence/snapshot.js';
import { deleteWorld, loadWorld, loadWorldMeta, saveWorld } from '../sim/persistence/idb.js';
import { SYSTEM_PROMPT } from '../sim/thoughts/prompt.js';
import { TREE_STATE } from '../sim/flora/trees.js';

export function createSimRuntime(post, deps = {}) {
  const {
    CANNON = null, idb = null,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (h) => clearTimeout(h),
  } = deps;

  let world = null;
  let selected = NONE;
  let llmEnabled = false;
  let paused = false;
  let pool = [];
  let lastWall = 0;
  let lastSaveWall = 0;
  let timer = null;
  let disposed = false;
  let caps = {};
  let simLag = 0;

  const physicsFor = (seed) => {
    if (!CANNON) return null;
    try { return createPhysics(CANNON, generateIsland(seed), { substeps: caps.substeps ?? 2 }); } catch (err) { post({ type: 'error', where: 'physics', message: String(err?.message ?? err) }); return null; }
  };

  function terrainPayload() {
    const t = world.terrain;
    const trees = []; for (let k = 0; k < world.trees.count; k++) trees.push(world.trees.tile[k]);
    const bushes = []; for (let k = 0; k < world.bushes.count; k++) bushes.push(world.bushes.tile[k]);
    // NB: the tile-type array travels as tileType — "type" is the message kind.
    const height = t.height.slice(); const tileType = t.type.slice(); const tileState = world.tileState.slice();
    post({
      type: 'terrain', size: t.size, hash: t.hash, seed: world.seed, volcanoTile: t.volcanoTile, maxHeight: t.maxHeight,
      height, tileType, tileState, trees, bushes, huts: world.settlement.huts.map(h => ({ tile: h.tile, x: h.x, z: h.z })),
    }, [height.buffer, tileType.buffer, tileState.buffer]);
  }

  function announce(resumed) {
    pool = [];
    for (let k = 0; k < HOST.frameBuffers; k++) pool.push(createFrameBuffer(world.entities.cap, PROP_CAP));
    selected = NONE;
    lastWall = now(); lastSaveWall = now();
    post({ type: 'ready', seed: world.seed, tick: world.clock.tick, resumed, terrainHash: world.terrain.hash, cap: world.entities.cap, physics: world.physics.kind });
    terrainPayload();
    postStats(); postTiles();
    if (!timer && !disposed) timer = schedule(loop, HOST.loopMs);
  }

  function boot(msg) {
    caps = { creatureCap: msg.lowEnd ? LOW_END_CREATURE_CAP : (msg.caps?.creatureCap ?? CREATURE_CAP), substeps: msg.lowEnd ? 1 : (msg.caps?.substeps ?? 2) };
    llmEnabled = !!msg.llmEnabled;
    const fresh = () => { world = createWorld({ seed: msg.seed | 0, caps, physics: physicsFor(msg.seed | 0) }); announce(false); };
    if (msg.resume && idb) {
      loadWorld(idb).then((snap) => {
        if (disposed) return;
        const restored = snap ? restoreWorld(snap, { physics: physicsFor(snap.seed) }) : null;
        if (restored) { world = restored; announce(true); } else fresh();
      }).catch((err) => { post({ type: 'error', where: 'resume', message: String(err?.message ?? err) }); fresh(); });
      return;
    }
    fresh();
  }

  function postStats() {
    const s = world.stats();
    const history = new Int16Array(s.popHistory.length * 4);
    for (let k = 0; k < s.popHistory.length; k++) for (let sp = 0; sp < 4; sp++) history[k * 4 + sp] = s.popHistory[k][sp];
    const { popHistory: _ph, ...rest } = s;
    post({ type: 'stats', stats: { ...rest, llm: world.thoughts.stats(), llmEnabled, simLag, popHistory: history } }, [history.buffer]);
  }
  function postEvents() {
    const events = world.log.drain();
    if (events.length) post({ type: 'events', events });
  }
  function postDetail() { post({ type: 'detail', detail: selected === NONE ? null : world.detail(selected) }); }
  function postTiles() {
    const n = world.tileState.length;
    const grass = new Uint8Array(n);
    for (let i = 0; i < n; i++) grass[i] = Math.round(world.grass.biomass[i] * 255);
    const bushRipe = new Uint8Array(world.bushes.count);
    for (let k = 0; k < world.bushes.count; k++) bushRipe[k] = Math.round(world.bushes.ripeness[k] * 255);
    const tileState = world.tileState.slice(); const treeState = world.trees.state.slice();
    post({ type: 'tiles', tileState, grass, treeState, bushRipe, huts: world.settlement.huts.map(h => ({ tile: h.tile, x: h.x, z: h.z })), carcasses: world.carcasses.map(c => ({ x: c.x, z: c.z, species: c.species })) },
      [tileState.buffer, grass.buffer, treeState.buffer, bushRipe.buffer]);
  }
  function postFrame() {
    if (pool.length === 0) return;
    const buffer = pool.pop();
    encodeFrame(world, buffer, { selected, flags: llmEnabled ? FRAME.FLAG_LLM_READY : 0 });
    post({ type: 'frame', buffer }, [buffer]);
  }
  function save(reason) {
    if (!idb || !world) return Promise.resolve(false);
    const tick = world.clock.tick;
    return saveWorld(idb, snapshotWorld(world)).then(() => { post({ type: 'saved', tick, reason }); return true; })
      .catch((err) => { post({ type: 'error', where: 'save', message: String(err?.message ?? err) }); return false; });
  }

  function tick() {
    if (!world || disposed) return;
    const wall = now();
    const wallDt = (wall - lastWall) / 1000;
    lastWall = wall;
    if (paused) return;
    const steps = world.clock.advance(wallDt);
    const t0 = now();
    for (let k = 0; k < steps; k++) {
      world.step();
      const tk = world.clock.tick;
      if (tk % HOST.statsEveryTicks === 0) { postStats(); postEvents(); }
      if (selected !== NONE && tk % HOST.detailEveryTicks === 0) postDetail();
      if (tk % HOST.tilesEveryTicks === 0) postTiles();
    }
    if (steps > 0) {
      simLag = (now() - t0) / steps;
      postFrame();
    }
    if (llmEnabled) {
      const req = world.thoughts.next(selected);
      if (req) post({ type: 'thoughtRequest', handle: req.handle, prompt: req.prompt, system: SYSTEM_PROMPT });
    }
    if (wall - lastSaveWall >= HOST.autosaveSeconds * 1000) { lastSaveWall = wall; save('autosave'); }
  }

  function loop() {
    timer = null;
    tick();
    if (!disposed) timer = schedule(loop, HOST.loopMs);
  }

  const runtime = {
    get world() { return world; },
    get mode() { return 'runtime'; },
    tick,
    handle(msg) {
      if (disposed) return;
      switch (msg.type) {
        case 'probe':
          if (!idb) { post({ type: 'probeResult', exists: false }); return; }
          loadWorldMeta(idb).then((meta) => post({ type: 'probeResult', exists: !!meta, ...(meta ?? {}) }))
            .catch(() => post({ type: 'probeResult', exists: false }));
          return;
        case 'init': boot(msg); return;
        case 'newWorld':
          if (idb) deleteWorld(idb).catch(() => {});
          if (world?.physics?.dispose) world.physics.dispose();
          world = createWorld({ seed: msg.seed | 0, caps, physics: physicsFor(msg.seed | 0) });
          announce(false);
          return;
        case 'setSpeed': world?.applyCommand({ type: 'setSpeed', speed: msg.speed }); return;
        case 'pause': paused = true; return;
        case 'resume': paused = false; lastWall = now(); return;
        case 'select':
          selected = msg.handle ?? NONE;
          // A creature the rotation has not reached yet would open with an empty quote.
          if (world && selected !== NONE) world.thoughts.template(selected);
          if (world) postDetail();
          return;
        case 'setLlmEnabled': llmEnabled = !!msg.enabled; if (!llmEnabled && world) world.thoughts.cancel(); return;
        case 'thoughtResult': if (world) world.thoughts.apply(msg.handle, msg.text); return;
        case 'thoughtCancel': world?.thoughts.cancel(); return;
        case 'saveNow': lastSaveWall = now(); save(msg.reason ?? 'manual'); return;
        case 'recycle': if (msg.buffer && pool.length < HOST.frameBuffers) pool.push(msg.buffer); return;
        case 'debug': if (world) post({ type: 'debugResult', op: msg.op, result: world.debug(msg.op, msg.arg ?? {}) }); return;
        case 'dispose': runtime.dispose(); return;
        default: post({ type: 'error', where: 'handle', message: `unknown message ${msg.type}` });
      }
    },
    dispose() {
      disposed = true;
      if (timer) { cancel(timer); timer = null; }
      if (world?.physics?.dispose) world.physics.dispose();
      world = null;
    },
  };
  return runtime;
}

export { TREE_STATE };
