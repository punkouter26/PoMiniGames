import { describe, expect, it } from 'vitest';
import { createSimRuntime } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/host/simRuntime.js';
import { createSimHost } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/host/simHost.js';
import { memoryIdb } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/persistence/idb.js';
import { FRAME, frameViews } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/frame.js';
import { NONE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/entities.js';
import { CREATURE_CAP, HOST, PROP_CAP, TICK_SECONDS } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

const flush = () => new Promise(r => setTimeout(r, 0));

/** A runtime with a recording post and a manual clock (no timers). */
function harness(opts = {}) {
  const posted = [];
  const idb = memoryIdb();
  let now = 0;
  const rt = createSimRuntime((msg, transfer) => posted.push({ msg, transfer }), { CANNON: null, idb, now: () => now, schedule: () => 0, cancel: () => {}, ...opts });
  const advance = (seconds) => { now += seconds * 1000; rt.tick(); };
  const of = (type) => posted.filter(p => p.msg.type === type).map(p => p.msg);
  const last = (type) => { const l = of(type); return l[l.length - 1]; };
  return { rt, posted, idb, advance, of, last, clear: () => { posted.length = 0; } };
}

describe('sim runtime protocol', () => {
  it('init → ready + terrain; frames flow while the buffer pool lasts and resume on recycle', () => {
    const h = harness();
    h.rt.handle({ type: 'init', seed: 7, resume: false, llmEnabled: false });
    const ready = h.last('ready');
    expect(ready.seed).toBe(7); expect(ready.resumed).toBe(false); expect(ready.tick).toBe(0);
    const terrain = h.last('terrain');
    expect(terrain.size).toBe(200);
    expect(terrain.height).toBeInstanceOf(Float32Array);
    expect(terrain.tileType).toBeInstanceOf(Uint8Array);
    expect(terrain.huts.length).toBe(3);
    expect(terrain.trees.length).toBeGreaterThan(100);
    expect(terrain.bushes.length).toBeGreaterThan(20);
    expect(terrain.volcanoTile).toBeGreaterThanOrEqual(0);

    for (let k = 0; k < HOST.frameBuffers + 2; k++) h.advance(TICK_SECONDS);
    const frames = h.of('frame');
    expect(frames.length).toBe(HOST.frameBuffers);           // pool exhausted, no allocation
    const v = frameViews(frames[0].buffer, CREATURE_CAP, PROP_CAP);
    expect(v.header[FRAME.H_TICK]).toBe(1);
    expect(v.header[FRAME.H_COUNT]).toBeGreaterThan(70);
    expect(h.posted.find(p => p.msg.type === 'frame').transfer).toEqual([frames[0].buffer]);
    h.rt.handle({ type: 'recycle', buffer: frames[0].buffer });
    h.advance(TICK_SECONDS);
    expect(h.of('frame').length).toBe(HOST.frameBuffers + 1);
    expect(h.rt.world.clock.tick).toBe(HOST.frameBuffers + 3);
  });

  it('paces the world by wall time and speed, and pauses', () => {
    const h = harness();
    h.rt.handle({ type: 'init', seed: 1, llmEnabled: false });
    h.advance(0.5);
    expect(h.rt.world.clock.tick).toBe(4);                   // capped at MAX_STEPS_PER_TICK per wake-up
    h.rt.handle({ type: 'setSpeed', speed: 0 });
    h.advance(1);
    expect(h.rt.world.clock.tick).toBe(4);
    h.rt.handle({ type: 'setSpeed', speed: 2 });
    h.advance(TICK_SECONDS);
    expect(h.rt.world.clock.tick).toBe(6);
    h.rt.handle({ type: 'pause' });
    h.advance(1);
    expect(h.rt.world.clock.tick).toBe(6);
    h.rt.handle({ type: 'resume' });
    h.advance(TICK_SECONDS);
    expect(h.rt.world.clock.tick).toBe(8);
  });

  it('serves selection detail, periodic stats/events/tiles, and the debug ops', () => {
    const h = harness();
    h.rt.handle({ type: 'init', seed: 2, llmEnabled: false });
    const handle = h.rt.world.entities.handle(0);
    h.rt.handle({ type: 'select', handle });
    const d = h.last('detail');
    expect(d.detail.handle).toBe(handle);
    expect(d.detail.name).toBe(h.rt.world.entities.names[0]);
    h.clear();
    for (let k = 0; k < HOST.statsEveryTicks * 2; k++) h.advance(TICK_SECONDS);
    expect(h.of('stats').length).toBeGreaterThanOrEqual(1);
    expect(h.last('stats').stats.counts.length).toBe(4);
    expect(h.of('detail').length).toBeGreaterThanOrEqual(1);
    expect(h.of('events').every(m => Array.isArray(m.events))).toBe(true);
    for (let k = 0; k < HOST.tilesEveryTicks; k++) h.advance(TICK_SECONDS);
    const tiles = h.last('tiles');
    expect(tiles.tileState).toBeInstanceOf(Uint8Array);
    expect(tiles.grass).toBeInstanceOf(Uint8Array);
    expect(tiles.grass.length).toBe(200 * 200);
    expect(tiles.treeState).toBeInstanceOf(Uint8Array);
    h.rt.handle({ type: 'select', handle: NONE });
    h.clear();
    h.rt.handle({ type: 'debug', op: 'massKill', arg: { species: 2 } });
    h.advance(TICK_SECONDS);
    expect(h.rt.world.stats().counts[2]).toBe(0);
    expect(h.last('debugResult').result).toBeGreaterThan(0);
  });

  it('asks for thoughts only when the LLM is enabled and applies answers', () => {
    const h = harness();
    h.rt.handle({ type: 'init', seed: 3, llmEnabled: false });
    h.advance(TICK_SECONDS);
    expect(h.of('thoughtRequest').length).toBe(0);
    h.rt.handle({ type: 'setLlmEnabled', enabled: true });
    h.advance(TICK_SECONDS);
    const req = h.last('thoughtRequest');
    expect(req.handle).not.toBe(NONE);
    expect(req.prompt.length).toBeGreaterThan(50);
    expect(req.system.length).toBeGreaterThan(20);
    h.advance(TICK_SECONDS);
    expect(h.of('thoughtRequest').length).toBe(1);          // one in flight
    h.rt.handle({ type: 'thoughtResult', handle: req.handle, text: '{"thought":"Hm.","trait":"curiosity","delta":0.1}' });
    expect(h.rt.world.thoughts.stats().applied).toBe(1);
    h.advance(TICK_SECONDS);
    expect(h.of('thoughtRequest').length).toBe(2);
    h.rt.handle({ type: 'thoughtCancel' });
    h.rt.handle({ type: 'setLlmEnabled', enabled: false });
    for (let k = 0; k < HOST.statsEveryTicks + 1; k++) h.advance(TICK_SECONDS);
    expect(h.of('thoughtRequest').length).toBe(2);
    expect(h.last('stats').stats.llm.requested).toBe(2);
  });

  it('autosaves, saves on demand, and resumes from the store', async () => {
    const h = harness();
    h.rt.handle({ type: 'init', seed: 9, llmEnabled: false });
    for (let k = 0; k < 40; k++) h.advance(TICK_SECONDS);
    expect(await h.idb.get('current')).toBe(null);
    h.rt.handle({ type: 'saveNow' });
    await flush();
    const saved = await h.idb.get('current');
    expect(saved.seed).toBe(9); expect(saved.tick).toBe(40);
    expect(h.last('saved').tick).toBe(40);
    h.advance(HOST.autosaveSeconds + 1);
    await flush();
    expect((await h.idb.get('current')).tick).toBeGreaterThan(40);

    const h2 = harness({ idb: h.idb });
    h2.rt.handle({ type: 'probe' });
    await flush();
    expect(h2.last('probeResult').exists).toBe(true);
    expect(h2.last('probeResult').seed).toBe(9);
    h2.rt.handle({ type: 'init', seed: 0, resume: true, llmEnabled: false });
    await flush();
    const ready = h2.last('ready');
    expect(ready.resumed).toBe(true); expect(ready.seed).toBe(9); expect(ready.tick).toBeGreaterThan(40);
    h2.rt.handle({ type: 'newWorld', seed: 11 });
    await flush();
    expect(h2.last('ready').seed).toBe(11); expect(h2.last('ready').tick).toBe(0);
    expect(await h.idb.get('current')).toBe(null);           // New World clears the save
  });
});

describe('sim host', () => {
  it('falls back to the inline runtime when the worker cannot start, and forwards messages', async () => {
    const received = [];
    const host = await createSimHost({
      onMessage: (m) => received.push(m),
      WorkerCtor: class { constructor() { throw new Error('no workers here'); } },
      importCannon: async () => null,
      idb: memoryIdb(),
    });
    expect(host.mode).toBe('inline');
    host.send({ type: 'init', seed: 4, llmEnabled: false });
    await new Promise(r => setTimeout(r, 0));
    expect(received.some(m => m.type === 'ready' && m.seed === 4)).toBe(true);
    host.dispose();
  });
});
