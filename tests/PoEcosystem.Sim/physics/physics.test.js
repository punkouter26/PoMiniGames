import { describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import { G_PROP, G_RAGDOLL, G_TERRAIN, createPhysics } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/physics/world.js';
import { RIGS, lyingPose } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/physics/ragdoll.js';
import { explosionImpulse } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/physics/explosion.js';
import { createWorld, nullPhysics } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/world.js';
import { generateIsland } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/island.js';
import { TILE, tileX, tileZ } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/tiles.js';
import { SPECIES_ID } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/species.js';
import { createRng } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/prng.js';
import { FRAME } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/frame.js';
import { PHYSICS, PROP_CAP, PROP_KIND, TICK_SECONDS } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

const terrain = generateIsland(5);
// Bodies roll on slopes, so the drop tests use a tile whose four corners are nearly level.
const tileOfType = (type, from = 0) => {
  const cs = terrain.size + 1;
  for (let i = from; i < terrain.type.length; i++) {
    if (terrain.type[i] !== type) continue;
    const x = tileX(i, terrain.size); const z = tileZ(i, terrain.size); const o = z * cs + x;
    const hs = [terrain.height[o], terrain.height[o + 1], terrain.height[o + cs], terrain.height[o + cs + 1]];
    if (Math.max(...hs) - Math.min(...hs) < 0.15) return i;
  }
  return -1;
};
const at = (tile) => { const x = tileX(tile, terrain.size) + 0.5; const z = tileZ(tile, terrain.size) + 0.5; return { x, z, y: terrain.heightAt(x, z) }; };
const run = (p, seconds) => { for (let k = 0; k < seconds / TICK_SECONDS; k++) p.step(TICK_SECONDS); };
const readAll = (p) => { const view = new Float32Array(PROP_CAP * FRAME.PROP_STRIDE); const n = p.readProps(view, PROP_CAP); return { n, view }; };
const kindOf = (view, k) => Math.floor(view[k * FRAME.PROP_STRIDE + 7] / 8);

describe('physics world', () => {
  it('builds a heightfield the terrain agrees with: a dropped sphere rests on the ground', () => {
    const p = createPhysics(CANNON, terrain);
    const g = at(tileOfType(TILE.GRASS, 40 * terrain.size));
    const ball = new CANNON.Body({ mass: 1, shape: new CANNON.Sphere(0.3), collisionFilterGroup: G_PROP, collisionFilterMask: G_TERRAIN | G_PROP | G_RAGDOLL });
    ball.position.set(g.x, g.y + 5, g.z);
    p.world.addBody(ball);
    run(p, 5);
    // It may roll, so compare with the terrain under wherever it ended up: never inside it.
    const ground = terrain.heightAt(ball.position.x, ball.position.z);
    expect(ball.position.y).toBeGreaterThan(ground - 0.2);
    expect(ball.position.y).toBeLessThan(ground + 0.9);
    expect(p.kind).toBe('cannon');
    p.dispose();
  });

  it('turns a death into a ragdoll that settles into a static carcass within 10 s', () => {
    const p = createPhysics(CANNON, terrain);
    const g = at(tileOfType(TILE.GRASS, 60 * terrain.size));
    p.onDeath({ ...g, yaw: 0.3, species: SPECIES_ID.RABBIT, scale: 1, handle: 5 }, 'predation', createRng(1));
    let r = readAll(p);
    expect(r.n).toBe(RIGS.quadruped.parts.length);
    for (let k = 0; k < r.n; k++) expect(kindOf(r.view, k)).toBe(PROP_KIND.ragdollPart);
    expect(p.activeRagdolls).toBe(1);
    run(p, 10);
    expect(p.activeRagdolls).toBe(0);
    r = readAll(p);
    expect(r.n).toBe(RIGS.quadruped.parts.length);
    for (let k = 0; k < r.n; k++) {
      const o = k * FRAME.PROP_STRIDE;
      const ground = terrain.heightAt(r.view[o], r.view[o + 2]);
      expect(r.view[o + 1]).toBeGreaterThan(ground - 0.6); expect(r.view[o + 1]).toBeLessThan(ground + 2);
    }
    // Carcass parts stay for the carcass lifetime, then go.
    run(p, PHYSICS.carcassSeconds + 1);
    expect(readAll(p).n).toBe(0);
    p.dispose();
  });

  it('caps active ragdolls: beyond the cap a death lies down statically at once', () => {
    const p = createPhysics(CANNON, terrain, { maxActiveRagdolls: 2 });
    const g = at(tileOfType(TILE.GRASS, 80 * terrain.size));
    const rng = createRng(2);
    for (let k = 0; k < 3; k++) p.onDeath({ ...g, x: g.x + k, yaw: 0, species: SPECIES_ID.HUMAN, scale: 1, handle: k }, 'starvation', rng);
    expect(p.activeRagdolls).toBe(2);
    expect(readAll(p).n).toBe(RIGS.biped.parts.length * 3);
    const pose = lyingPose(SPECIES_ID.HUMAN, 10, 3, 10, 1.2, 1);
    expect(pose.length).toBe(RIGS.biped.parts.length);
    for (const part of pose) { expect(part.y).toBeGreaterThan(3); expect(part.y).toBeLessThan(4); expect(Math.hypot(part.qx, part.qy, part.qz, part.qw)).toBeCloseTo(1, 5); }
    p.dispose();
  });

  it('fells a tree that swings on a hinge, then rests as a log near the ground', () => {
    const p = createPhysics(CANNON, terrain);
    const f = at(tileOfType(TILE.FOREST));
    p.fellTree({ ...f, dirX: 1, dirZ: 0 }, createRng(3));
    let r = readAll(p);
    expect(r.n).toBe(1);
    expect(kindOf(r.view, 0)).toBe(PROP_KIND.log);
    expect(r.view[1]).toBeGreaterThan(f.y + 0.5);            // starts upright: centre above ground
    run(p, 8);
    r = readAll(p);
    expect(r.n).toBe(1);
    expect(r.view[1]).toBeLessThan(terrain.heightAt(r.view[0], r.view[2]) + 1.0); // lying down
    expect(r.view[0]).toBeGreaterThan(f.x + 0.5);            // fell in the push direction
    expect(p.settledCount()).toBe(1);
    p.dispose();
  });

  it('rolls rocks downhill and settles them as boulders', () => {
    const p = createPhysics(CANNON, terrain);
    const summit = at(terrain.volcanoTile);
    p.spawnRocks({ x: summit.x, y: summit.y + 2, z: summit.z, count: 4, speed: 6 }, createRng(4));
    let r = readAll(p);
    expect(r.n).toBe(4);
    for (let k = 0; k < r.n; k++) expect(kindOf(r.view, k)).toBe(PROP_KIND.rock);
    run(p, 15);
    r = readAll(p);
    expect(r.n).toBe(4);
    let lower = 0;
    for (let k = 0; k < r.n; k++) if (r.view[k * FRAME.PROP_STRIDE + 1] < summit.y - 0.5) lower++;
    expect(lower).toBeGreaterThanOrEqual(2);
    expect(p.settledCount()).toBeGreaterThanOrEqual(2);
    p.dispose();
  });

  it('explosion impulse falls off with distance and launches nearby bodies', () => {
    expect(explosionImpulse(1, 6, 10)).toBeCloseTo(explosionImpulse(3, 6, 10) * 3, 5);
    expect(explosionImpulse(7, 6, 10)).toBe(0);
    expect(explosionImpulse(0, 6, 10)).toBeLessThanOrEqual(explosionImpulse(0.5, 6, 10) * 1.01);
    const p = createPhysics(CANNON, terrain);
    const g = at(tileOfType(TILE.GRASS, 100 * terrain.size));
    p.onDeath({ ...g, yaw: 0, species: SPECIES_ID.DEER, scale: 1, handle: 1 }, 'lightning', createRng(5));
    run(p, 0.5);
    const before = readAll(p);
    p.explode({ x: g.x + 1, y: g.y, z: g.z, radius: 6, strength: 40 });
    run(p, 0.3);
    const after = readAll(p);
    let moved = 0;
    for (let k = 0; k < after.n; k++) if (Math.abs(after.view[k * FRAME.PROP_STRIDE] - before.view[k * FRAME.PROP_STRIDE]) > 0.3) moved++;
    expect(moved).toBeGreaterThan(0);
    p.dispose();
  });

  it('never writes more props than the view holds', () => {
    const p = createPhysics(CANNON, terrain);
    const g = at(tileOfType(TILE.GRASS, 120 * terrain.size));
    p.spawnRocks({ x: g.x, y: g.y + 3, z: g.z, count: 10, speed: 2 }, createRng(6));
    const view = new Float32Array(4 * FRAME.PROP_STRIDE);
    expect(p.readProps(view, 4)).toBe(4);
    p.dispose();
  });

  it('is invisible to the simulation: cannon and null physics give the same population', { timeout: 60_000 }, () => {
    const a = createWorld({ seed: 11, physics: createPhysics(CANNON, generateIsland(11)) });
    const b = createWorld({ seed: 11, physics: nullPhysics() });
    for (let k = 0; k < 2400; k++) { a.step(); b.step(); }
    expect(a.stats().counts).toEqual(b.stats().counts);
    const pa = []; const pb = [];
    a.entities.forEachAlive(i => pa.push(i, a.entities.x[i], a.entities.z[i]));
    b.entities.forEachAlive(i => pb.push(i, b.entities.x[i], b.entities.z[i]));
    expect(pa).toEqual(pb);
    expect(a.physics.kind).toBe('cannon');
    expect(readAll(a.physics).n).toBeGreaterThan(0); // deaths did produce props
    a.physics.dispose();
  });
});
