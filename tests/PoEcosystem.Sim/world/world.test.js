import { describe, expect, it } from 'vitest';
import { createWorld } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/world.js';
import { FRAME, createFrameBuffer, encodeFrame, frameViews } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/frame.js';
import { SPECIES_ID } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/species.js';
import { isWalkable, tileIndex } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/tiles.js';
import { NONE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/entities.js';
import { CREATURE_CAP, POPULATION, PROP_CAP } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

const stepN = (w, n) => { for (let k = 0; k < n; k++) w.step(); };

describe('world', () => {
  it('creates the starting population on walkable tiles quickly', () => {
    createWorld({ seed: 6 });                 // warm the JIT: the first call in a process also
    const t0 = performance.now();             // pays for compiling terrain, flora and behaviour
    const w = createWorld({ seed: 7 });
    const ms = performance.now() - t0;
    expect(ms, `world creation took ${ms.toFixed(0)} ms`).toBeLessThan(300);
    const s = w.stats();
    expect(s.counts).toEqual([POPULATION.rabbits, POPULATION.deer, POPULATION.wolves, POPULATION.humans]);
    expect(s.huts).toBe(POPULATION.huts);
    expect(s.tick).toBe(0);
    w.entities.forEachAlive(i => {
      expect(isWalkable(w.terrain.type[tileIndex(w.entities.x[i], w.entities.z[i], w.terrain.size)])).toBe(true);
      expect(w.entities.names[i].length).toBeGreaterThan(1);
    });
  });

  it('runs, keeps creatures on land, logs births and deaths, and reports stats', () => {
    const w = createWorld({ seed: 3 });
    stepN(w, 20 * 120); // two minutes
    w.entities.forEachAlive(i => {
      expect(isWalkable(w.terrain.type[tileIndex(w.entities.x[i], w.entities.z[i], w.terrain.size)])).toBe(true);
      expect(Number.isFinite(w.entities.y[i])).toBe(true);
    });
    const kinds = new Set(w.log.all().map(ev => ev.kind));
    expect(kinds.has('birth')).toBe(true);
    expect(kinds.has('death')).toBe(true);
    const s = w.stats();
    expect(s.tick).toBe(2400);
    expect(s.year).toBe(4);
    expect(s.alive).toBe(s.counts.reduce((a, b) => a + b, 0));
    expect(s.alive).toBeGreaterThan(20);
    expect(s.popHistory.length).toBeGreaterThan(100);
    expect(s.popHistory[s.popHistory.length - 1].length).toBe(4);
  });

  it('is deterministic: two worlds with the same seed agree at tick 6000', { timeout: 60_000 }, () => {
    const a = createWorld({ seed: 7 }); const b = createWorld({ seed: 7 });
    stepN(a, 6000); stepN(b, 6000);
    expect(a.stats().counts).toEqual(b.stats().counts);
    expect(a.stats().alive).toBeGreaterThan(0);
    const posA = []; const posB = [];
    a.entities.forEachAlive(i => posA.push(i, a.entities.x[i], a.entities.z[i], a.entities.names[i]));
    b.entities.forEachAlive(i => posB.push(i, b.entities.x[i], b.entities.z[i], b.entities.names[i]));
    expect(posA).toEqual(posB);
    expect(a.log.count).toBe(b.log.count);
    const c = createWorld({ seed: 8 });
    stepN(c, 6000);
    expect(c.stats().counts).not.toEqual(a.stats().counts);
  });

  it('detects extinctions and the last species standing', () => {
    const w = createWorld({ seed: 5 });
    w.debug('massKill', { species: SPECIES_ID.WOLF });
    w.step();
    expect(w.stats().counts[SPECIES_ID.WOLF]).toBe(0);
    expect(w.log.all().some(ev => ev.kind === 'extinction' && ev.species === SPECIES_ID.WOLF)).toBe(true);
    expect(w.stats().lastStanding).toBe(NONE);
    w.debug('massKill', { species: SPECIES_ID.RABBIT });
    w.debug('massKill', { species: SPECIES_ID.DEER });
    w.step();
    expect(w.stats().lastStanding).toBe(SPECIES_ID.HUMAN);
    w.debug('massKill', { species: SPECIES_ID.HUMAN });
    w.step();
    expect(w.stats().alive).toBe(0);
    expect(w.stats().silent).toBe(true);
    stepN(w, 100); // keeps running without creatures
  });

  it('caps the population and logs once when the island is full', () => {
    const w = createWorld({ seed: 2, caps: { creatureCap: 80 } });
    expect(w.entities.cap).toBe(80);
    stepN(w, 20 * 240);
    expect(w.stats().alive).toBeLessThanOrEqual(80);
    const full = w.log.all().filter(ev => ev.kind === 'full');
    expect(full.length).toBeLessThanOrEqual(5);
  });

  it('encodes a frame the renderer can read back', () => {
    const w = createWorld({ seed: 4 });
    stepN(w, 10);
    const buf = createFrameBuffer(CREATURE_CAP, PROP_CAP);
    encodeFrame(w, buf, { selected: w.entities.handle(0) });
    const v = frameViews(buf, CREATURE_CAP, PROP_CAP);
    expect(v.header[FRAME.H_TICK]).toBe(10);
    expect(v.header[FRAME.H_COUNT]).toBe(w.stats().alive);
    expect(v.header[FRAME.H_SELECTED]).toBe(w.entities.handle(0));
    for (let k = 0; k < v.header[FRAME.H_COUNT]; k++) {
      const i = w.entities.resolve(v.handles[k]);
      expect(i).not.toBe(NONE);
      const o = k * FRAME.CREATURE_STRIDE;
      expect(v.creatures[o]).toBeCloseTo(w.entities.x[i], 5);
      expect(v.creatures[o + 2]).toBeCloseTo(w.entities.z[i], 5);
      expect(v.creatures[o + 5]).toBe(w.entities.species[i]);
      expect(v.creatures[o + 4]).toBeGreaterThan(0);
    }
    expect(v.header[FRAME.H_PROPS]).toBe(0);
    expect(buf.byteLength).toBe(FRAME.bytes(CREATURE_CAP, PROP_CAP));
  });

  it('exposes creature detail for the inspector', () => {
    const w = createWorld({ seed: 4 });
    stepN(w, 40);
    const h = w.entities.handle(3);
    const d = w.detail(h);
    expect(d.name).toBe(w.entities.names[3]);
    expect(d.species).toBe(w.entities.species[3]);
    expect(d.traits.length).toBe(5);
    expect(typeof d.goal).toBe('string');
    expect(d.ageYears).toBeGreaterThanOrEqual(0);
    expect(['hunger', 'thirst', 'health'].every(k => d[k] >= 0 && d[k] <= 1)).toBe(true);
    expect(w.detail(NONE)).toBe(null);
  });
});
