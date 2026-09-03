import { describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import { SNAPSHOT_VERSION, restoreWorld, snapshotWorld } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/persistence/snapshot.js';
import { deleteWorld, loadWorld, memoryIdb, saveWorld } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/persistence/idb.js';
import { PREF_DEFAULTS, createPrefs, memoryStorage } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/persistence/prefs.js';
import { createWorld, nullPhysics } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/world.js';
import { createPhysics } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/physics/world.js';
import { generateIsland } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/island.js';
import { NONE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/entities.js';
import { FRAME } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/frame.js';
import { PROP_CAP } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

const stepN = (w, n) => { for (let k = 0; k < n; k++) w.step(); };
const fingerprint = (w) => {
  const e = w.entities; const out = [];
  e.forEachAlive(i => out.push(i, e.x[i], e.z[i], e.hunger[i], e.goal[i], e.names[i], e.lastThought[i]));
  return { pos: out, counts: w.stats().counts, log: w.log.count, tiles: Array.from(w.tileState), rng: w.streams.getState(), tick: w.clock.tick, pop: w.stats().popHistory.length, thoughts: w.thoughts.stats() };
};

describe('snapshot round trip', () => {
  it('restores a world that continues exactly like the original', { timeout: 60_000 }, () => {
    const a = createWorld({ seed: 5 });
    stepN(a, 900);
    a.debug('lightning'); a.debug('rockslide');
    stepN(a, 300);
    const req = a.thoughts.next(NONE); a.thoughts.apply(req.handle, '{"thought":"Still here.","trait":"boldness","delta":0.1}');
    const snap = snapshotWorld(a);
    expect(snap.schemaVersion).toBe(SNAPSHOT_VERSION);
    expect(snap.seed).toBe(5);
    expect(snap.terrainHash).toBe(a.terrain.hash);
    const clone = structuredClone(snap);            // what IndexedDB does
    const b = restoreWorld(clone, { physics: nullPhysics() });
    expect(b).not.toBe(null);
    expect(fingerprint(b)).toEqual(fingerprint(a));
    stepN(a, 400); stepN(b, 400);
    expect(fingerprint(b)).toEqual(fingerprint(a));
    expect(b.stats().naturalEvents).toEqual(a.stats().naturalEvents);
  });

  it('refuses a snapshot from another schema or another terrain', () => {
    const a = createWorld({ seed: 2 });
    stepN(a, 20);
    const snap = snapshotWorld(a);
    expect(restoreWorld({ ...snap, schemaVersion: SNAPSHOT_VERSION + 1 })).toBe(null);
    expect(restoreWorld({ ...snap, terrainHash: snap.terrainHash ^ 1 })).toBe(null);
    expect(restoreWorld(null)).toBe(null);
    expect(restoreWorld({})).toBe(null);
  });

  it('carries settled physics props and drops unsettled ragdolls into lying poses', () => {
    const seed = 3;
    const a = createWorld({ seed, physics: createPhysics(CANNON, generateIsland(seed)) });
    stepN(a, 5);
    const victims = [];
    a.entities.forEachAlive(i => { if (victims.length < 3) victims.push(i); });
    for (const i of victims) a.kill(i, 'starvation');
    stepN(a, 20 * 12);                                     // settled by now
    const settledBefore = a.physics.settledCount();
    expect(settledBefore).toBeGreaterThan(0);
    a.kill(a.entities.handle ? (() => { let f = -1; a.entities.forEachAlive(i => { if (f < 0) f = i; }); return f; })() : 0, 'predation');
    const snap = snapshotWorld(a);
    expect(snap.props.length).toBeGreaterThanOrEqual(settledBefore);
    const b = restoreWorld(structuredClone(snap), { physics: createPhysics(CANNON, generateIsland(seed)) });
    const view = new Float32Array(PROP_CAP * FRAME.PROP_STRIDE);
    expect(b.physics.readProps(view, PROP_CAP)).toBe(snap.props.length);
    expect(b.physics.activeRagdolls).toBe(0);
    a.physics.dispose(); b.physics.dispose();
  });
});

describe('world store', () => {
  it('saves, loads and deletes through the injectable store', async () => {
    const db = memoryIdb();
    const w = createWorld({ seed: 8 });
    stepN(w, 50);
    await saveWorld(db, snapshotWorld(w));
    const loaded = await loadWorld(db);
    expect(loaded.seed).toBe(8);
    expect(loaded.tick).toBe(50);
    const meta = await db.get('meta');
    expect(meta.seed).toBe(8);
    expect(meta.year).toBe(w.stats().year);
    await deleteWorld(db);
    expect(await loadWorld(db)).toBe(null);
  });
});

describe('prefs', () => {
  it('reads typed defaults, persists changes, and survives garbage', () => {
    const storage = memoryStorage();
    const p = createPrefs(storage);
    expect(p.get('llmEnabled')).toBe(PREF_DEFAULTS.llmEnabled);
    expect(p.get('modelId')).toBe(PREF_DEFAULTS.modelId);
    p.set('speed', 2); p.set('llmEnabled', false); p.set('seed', 'island of dreams');
    expect(createPrefs(storage).get('speed')).toBe(2);
    expect(createPrefs(storage).get('llmEnabled')).toBe(false);
    expect(createPrefs(storage).get('seed')).toBe('island of dreams');
    storage.setItem('poeco:speed', '{not json');
    expect(createPrefs(storage).get('speed')).toBe(PREF_DEFAULTS.speed);
    p.set('player', { x: 1, y: 2, z: 3, yaw: 0.5, pitch: -0.1, fly: false });
    expect(createPrefs(storage).get('player')).toEqual({ x: 1, y: 2, z: 3, yaw: 0.5, pitch: -0.1, fly: false });
    expect(createPrefs(null).get('speed')).toBe(PREF_DEFAULTS.speed);  // no storage at all
  });
});
