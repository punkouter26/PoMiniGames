import { describe, expect, it } from 'vitest';
import { createEntities, NONE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/entities.js';
import { TRAITS } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

describe('entities (SoA store)', () => {
  it('allocates dense indices, frees deterministically and reuses slots LIFO', () => {
    const e = createEntities(4);
    expect([e.alloc(), e.alloc(), e.alloc(), e.alloc()]).toEqual([0, 1, 2, 3]);
    expect(e.alloc()).toBe(-1);
    expect(e.count).toBe(4);
    expect(e.high).toBe(4);
    e.free(1); e.free(2);
    expect(e.count).toBe(2);
    expect(e.alloc()).toBe(2);
    expect(e.alloc()).toBe(1);
    expect(e.alive[1]).toBe(1);
  });

  it('handles carry a generation so stale references resolve to NONE', () => {
    const e = createEntities(8);
    const i = e.alloc();
    const h = e.handle(i);
    expect(e.resolve(h)).toBe(i);
    e.free(i);
    expect(e.resolve(h)).toBe(NONE);
    const j = e.alloc();
    expect(j).toBe(i);
    expect(e.resolve(h)).toBe(NONE);
    expect(e.resolve(e.handle(j))).toBe(j);
    expect(e.resolve(NONE)).toBe(NONE);
  });

  it('resets every column on alloc so a reused slot carries nothing over', () => {
    const e = createEntities(2);
    const i = e.alloc();
    e.x[i] = 5; e.hunger[i] = 0.9; e.traits[i * TRAITS.length + 2] = 0.7; e.mother[i] = 3;
    e.names[i] = 'Ember'; e.lastThought[i] = 'hungry';
    e.free(i);
    const j = e.alloc();
    expect(j).toBe(i);
    expect(e.x[j]).toBe(0);
    expect(e.hunger[j]).toBe(0);
    expect(e.traits[j * TRAITS.length + 2]).toBe(0);
    expect(e.mother[j]).toBe(NONE);
    expect(e.target[j]).toBe(NONE);
    expect(e.names[j]).toBe('');
    expect(e.lastThought[j]).toBe('');
  });

  it('iterates live entities in index order only', () => {
    const e = createEntities(6);
    for (let k = 0; k < 5; k++) e.alloc();
    e.free(1); e.free(3);
    const seen = [];
    e.forEachAlive(i => seen.push(i));
    expect(seen).toEqual([0, 2, 4]);
  });

  it('exposes the column set the frame encoder and snapshot rely on', () => {
    const e = createEntities(3);
    for (const col of ['x', 'y', 'z', 'yaw', 'vx', 'vz', 'age', 'hunger', 'thirst', 'health', 'scale']) expect(e[col]).toBeInstanceOf(Float32Array);
    for (const col of ['species', 'lifeStage', 'state', 'goal', 'sex', 'alive', 'lastThoughtSource']) expect(e[col]).toBeInstanceOf(Uint8Array);
    for (const col of ['mother', 'father', 'target', 'leader', 'homeTile', 'memFoodTile', 'memFoodTick', 'memWaterTile', 'memWaterTick', 'birthTick', 'gestationEndTick', 'lastMateTick', 'goalSince', 'nudgeEndTick']) expect(e[col]).toBeInstanceOf(Int32Array);
    expect(e.traits.length).toBe(3 * TRAITS.length);
    expect(e.gen).toBeInstanceOf(Uint16Array);
    expect(e.columns().length).toBeGreaterThan(20);
  });
});
