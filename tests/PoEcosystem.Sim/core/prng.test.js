import { describe, expect, it } from 'vitest';
import { createRng, createStreams, hashString, mulberry32 } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/prng.js';
import { RNG_SALT } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

describe('prng', () => {
  it('mulberry32 is deterministic per seed and stays in [0,1)', () => {
    const a = mulberry32(7); const b = mulberry32(7); const c = mulberry32(8);
    const da = Array.from({ length: 1000 }, () => a());
    const db = Array.from({ length: 1000 }, () => b());
    const dc = Array.from({ length: 1000 }, () => c());
    expect(da).toEqual(db);
    expect(da).not.toEqual(dc);
    expect(da.every(v => v >= 0 && v < 1)).toBe(true);
  });

  it('createRng exposes int/range/pick/gaussian and a restorable state', () => {
    const r = createRng(42);
    for (let i = 0; i < 100; i++) {
      const n = r.int(6); expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThan(6);
      const f = r.range(-1, 1); expect(f).toBeGreaterThanOrEqual(-1); expect(f).toBeLessThan(1);
    }
    expect(['a', 'b', 'c']).toContain(r.pick(['a', 'b', 'c']));
    const g = Array.from({ length: 2000 }, () => r.gaussian());
    const mean = g.reduce((s, v) => s + v, 0) / g.length;
    expect(Math.abs(mean)).toBeLessThan(0.1);

    const state = r.getState();
    const before = [r.next(), r.next(), r.next()];
    r.setState(state);
    expect([r.next(), r.next(), r.next()]).toEqual(before);
    expect(Number.isInteger(state)).toBe(true);
  });

  it('createStreams derives one independent stream per salt', () => {
    const s1 = createStreams(99); const s2 = createStreams(99);
    for (const key of Object.keys(RNG_SALT)) {
      expect(typeof s1[key].next).toBe('function');
      expect(s1[key].next()).toBe(s2[key].next());
    }
    expect(s1.terrain.next()).not.toBe(s1.genetics.next());
    const states = s1.getState();
    expect(Object.keys(states).sort()).toEqual(Object.keys(RNG_SALT).sort());
    const t = createStreams(1); t.setState(states);
    expect(t.terrain.next()).toBe(s1.terrain.next());
  });

  it('hashString coerces any seed text to a stable uint32', () => {
    expect(hashString('island')).toBe(hashString('island'));
    expect(hashString('island')).not.toBe(hashString('Island'));
    expect(hashString('7')).toBe(7);
    expect(hashString('  12 ')).toBe(12);
    expect(hashString('')).toBeGreaterThanOrEqual(0);
    const h = hashString('a fairly long seed phrase');
    expect(h >>> 0).toBe(h);
  });
});
