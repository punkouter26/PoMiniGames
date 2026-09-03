import { describe, expect, it } from 'vitest';
import { PLAYER, createPlayer, stepPlayer } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/render/playerController.js';
import { generateIsland } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/island.js';
import { TILE, isWalkable, tileIndex, tileX, tileZ } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/tiles.js';
import { createRng } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/prng.js';

const terrain = generateIsland(5);
const DT = 1 / 60;
const beach = () => { for (let i = 0; i < terrain.type.length; i++) if (terrain.type[i] === TILE.BEACH) return i; return -1; };
const grass = (from = 60 * terrain.size) => { for (let i = from; i < terrain.type.length; i++) if (terrain.type[i] === TILE.GRASS) return i; return -1; };
const spawnAt = (tile, over = {}) => {
  const p = createPlayer(terrain);
  p.x = tileX(tile, terrain.size) + 0.5; p.z = tileZ(tile, terrain.size) + 0.5;
  p.y = terrain.heightAt(p.x, p.z) + PLAYER.eyeHeight;
  return Object.assign(p, over);
};
const input = (over = {}) => ({ forward: 0, right: 0, run: false, jump: false, up: 0, ...over });
const run = (p, inp, seconds, terrainArg = terrain) => { for (let k = 0; k < seconds / DT; k++) stepPlayer(p, inp, DT, terrainArg); return p; };

describe('first-person god controller', () => {
  it('stands at eye height and settles on the ground it spawns above', () => {
    const p = spawnAt(grass(), { y: terrain.heightAt(0, 0) + 30 });
    run(p, input(), 6);
    expect(p.y - terrain.heightAt(p.x, p.z)).toBeCloseTo(PLAYER.eyeHeight, 1);
    expect(p.grounded).toBe(true);
    expect(p.mode).toBe('walk');
  });

  it('walks and runs at the specified speeds in the direction it faces', () => {
    const p = spawnAt(grass());
    p.yaw = 0;                                   // facing +Z
    const z0 = p.z;
    run(p, input({ forward: 1 }), 1);
    expect(p.z - z0).toBeGreaterThan(PLAYER.walkSpeed * 0.8);
    expect(p.z - z0).toBeLessThan(PLAYER.walkSpeed * 1.2);
    const p2 = spawnAt(grass());
    p2.yaw = 0;
    const z2 = p2.z;
    run(p2, input({ forward: 1, run: true }), 1);
    expect(p2.z - z2).toBeGreaterThan(PLAYER.runSpeed * 0.8);
    // Strafing is perpendicular; diagonal input is normalised, never faster than forward alone.
    const p3 = spawnAt(grass());
    p3.yaw = 0;
    const start = [p3.x, p3.z];
    run(p3, input({ forward: 1, right: 1 }), 1);
    expect(Math.hypot(p3.x - start[0], p3.z - start[1])).toBeLessThan(PLAYER.walkSpeed * 1.2);
    expect(p3.x - start[0]).toBeGreaterThan(0.5);
  });

  it('jumps about a metre and comes back down', () => {
    const p = spawnAt(grass());
    run(p, input(), 0.5);
    const ground = p.y;
    let peak = ground;
    const inp = input({ jump: true });
    for (let k = 0; k < 1.2 / DT; k++) { stepPlayer(p, inp, DT, terrain); inp.jump = false; peak = Math.max(peak, p.y); }
    expect(peak - ground).toBeGreaterThan(0.6);
    expect(peak - ground).toBeLessThan(1.8);
    expect(p.y).toBeCloseTo(ground, 1);
    expect(p.grounded).toBe(true);
  });

  it('never falls through the island over a long random walk', () => {
    const p = spawnAt(grass());
    const rng = createRng(4);
    let minClearance = Infinity;
    for (let k = 0; k < 60 * 60 * 5; k++) {                 // five simulated minutes at 60 Hz
      if (k % 30 === 0) p.yaw += rng.range(-1, 1);
      stepPlayer(p, input({ forward: 1, run: rng.next() < 0.3, jump: rng.next() < 0.01 }), DT, terrain);
      const clearance = p.y - terrain.heightAt(p.x, p.z);
      if (p.mode === 'walk') minClearance = Math.min(minClearance, clearance);
      expect(p.x).toBeGreaterThanOrEqual(-PLAYER.boundary); expect(p.x).toBeLessThanOrEqual(terrain.size + PLAYER.boundary);
      expect(p.z).toBeGreaterThanOrEqual(-PLAYER.boundary); expect(p.z).toBeLessThanOrEqual(terrain.size + PLAYER.boundary);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(minClearance).toBeGreaterThan(PLAYER.eyeHeight - 0.15);
  });

  it('swims in deep water instead of walking, and wades at the shore', () => {
    const p = spawnAt(beach());
    p.yaw = Math.atan2(p.x - terrain.size / 2, p.z - terrain.size / 2);   // face away from the island centre
    run(p, input({ forward: 1 }), 8);
    expect(['swim', 'walk']).toContain(p.mode);
    if (p.mode === 'swim') {
      expect(p.y).toBeGreaterThan(-1);
      expect(p.y).toBeLessThan(PLAYER.eyeHeight + 0.6);
      const before = [p.x, p.z];
      run(p, input({ forward: 1 }), 1);
      const moved = Math.hypot(p.x - before[0], p.z - before[1]);
      expect(moved).toBeGreaterThan(0);
      expect(moved).toBeLessThan(PLAYER.walkSpeed);                       // swimming is slower
    }
  });

  it('flies free of the ground, clamps its altitude, and lands when switched back', () => {
    const p = spawnAt(grass());
    p.mode = 'fly';
    run(p, input({ up: 1 }), 6);
    expect(p.mode).toBe('fly');
    expect(p.y).toBeLessThanOrEqual(PLAYER.maxAltitude + 0.01);
    expect(p.y).toBeGreaterThan(terrain.heightAt(p.x, p.z) + 5);
    p.pitch = -0.4;
    run(p, input({ forward: 1 }), 2);
    expect(p.y).toBeGreaterThan(terrain.heightAt(p.x, p.z) + PLAYER.minFlyClearance - 0.01);
    p.mode = 'walk';
    run(p, input(), 10);
    expect(p.y - terrain.heightAt(p.x, p.z)).toBeCloseTo(PLAYER.eyeHeight, 1);
  });

  it('is pushed back at the world boundary', () => {
    const p = createPlayer(terrain);
    p.mode = 'fly';
    p.x = terrain.size + PLAYER.boundary - 1; p.z = terrain.size / 2; p.y = 20;
    p.yaw = Math.PI / 2;                                    // straight at the +x edge
    run(p, input({ forward: 1 }), 6);
    expect(p.x).toBeLessThanOrEqual(terrain.size + PLAYER.boundary);
    expect(p.blocked).toBe(true);
  });

  it('saves and restores its pose for Resume', () => {
    const p = spawnAt(grass());
    run(p, input({ forward: 1 }), 2);
    p.pitch = 0.2; p.mode = 'fly';
    const pose = p.pose();
    const q = createPlayer(terrain);
    q.setPose(pose);
    expect([q.x, q.y, q.z, q.yaw, q.pitch, q.mode]).toEqual([p.x, p.y, p.z, p.yaw, p.pitch, 'fly']);
    q.setPose(null);
    expect(Number.isFinite(q.x)).toBe(true);
    const r = createPlayer(terrain);
    r.setPose({ x: -999, y: 5, z: 5, yaw: 0, pitch: 0, mode: 'walk' });    // outside the map
    expect(isWalkable(terrain.type[tileIndex(r.x, r.z, terrain.size)]) || r.mode === 'swim').toBe(true);
  });

  it('clamps pitch and wraps yaw when looking around', () => {
    const p = spawnAt(grass());
    p.look(10, 10);
    expect(p.pitch).toBeLessThanOrEqual(PLAYER.maxPitch);
    p.look(-10, -10);
    expect(p.pitch).toBeGreaterThanOrEqual(-PLAYER.maxPitch);
    p.look(1000, 0);
    expect(Math.abs(p.yaw)).toBeLessThanOrEqual(Math.PI * 2);
    const dir = p.direction();
    expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1, 5);
  });
});
