import { describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import { EVENT_KIND, createEventScheduler } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/events/scheduler.js';
import { strikeLightning } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/events/lightning.js';
import { planRockslide, triggerRockslide } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/events/rockslide.js';
import { createWorld, nullPhysics } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/world.js';
import { createPhysics } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/physics/world.js';
import { generateIsland } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/island.js';
import { TILE, TILE_STATE, tileIndex, tileX, tileZ } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/terrain/tiles.js';
import { TREE_STATE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/flora/trees.js';
import { SPECIES_ID } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/species.js';
import { DEATH_CAUSE } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/lifecycle.js';
import { createRng } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/prng.js';
import { EVENTS, TICK_SECONDS } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

const secs = (s) => Math.round(s / TICK_SECONDS);

describe('event scheduler', () => {
  it('spaces natural events by their interval ranges and a global minimum gap', () => {
    const s = createEventScheduler(createRng(3));
    for (const kind of Object.values(EVENT_KIND)) {
      const [lo, hi] = EVENTS.intervalSeconds[kind];
      expect(s.nextTick(kind)).toBeGreaterThanOrEqual(secs(lo));
      expect(s.nextTick(kind)).toBeLessThanOrEqual(secs(hi));
    }
    const fired = [];
    for (let tick = 0; tick < secs(1800); tick++) {
      const kind = s.poll(tick);
      if (kind) fired.push([tick, kind]);
    }
    expect(fired.length).toBeGreaterThan(10);
    for (let k = 1; k < fired.length; k++) expect(fired[k][0] - fired[k - 1][0]).toBeGreaterThanOrEqual(secs(EVENTS.minSpacingSeconds));
    const kinds = new Set(fired.map(f => f[1]));
    expect(kinds.size).toBe(3);
    const s2 = createEventScheduler(createRng(3));
    const fired2 = [];
    for (let tick = 0; tick < secs(1800); tick++) { const kind = s2.poll(tick); if (kind) fired2.push([tick, kind]); }
    expect(fired2).toEqual(fired);
    const state = s.getState();
    const s3 = createEventScheduler(createRng(99)); s3.setState(state);
    expect(s3.nextTick(EVENT_KIND.LIGHTNING)).toBe(s.nextTick(EVENT_KIND.LIGHTNING));
  });
});

describe('lightning', () => {
  it('kills within 6 m, fells trees within 3 m, ignites and frightens the area, and logs', () => {
    const w = createWorld({ seed: 6 });
    w.debug('massKill');
    const t = w.terrain;
    let forest = -1;
    for (let i = 0; i < t.type.length; i++) if (t.type[i] === TILE.FOREST && w.trees.byTile[i] >= 0) { forest = i; break; }
    const cx = tileX(forest, t.size) + 0.5; const cz = tileZ(forest, t.size) + 0.5;
    const near = w.spawn(SPECIES_ID.DEER, cx + 3, cz);
    const far = w.spawn(SPECIES_ID.DEER, cx + 9, cz);
    const treeK = w.trees.byTile[forest];
    const before = w.log.count;
    strikeLightning(w, forest, w.streams.events);
    expect(w.entities.alive[near]).toBe(0);
    expect(w.entities.alive[far]).toBe(1);
    expect(w.log.all().some(ev => ev.kind === 'death' && ev.cause === DEATH_CAUSE.LIGHTNING)).toBe(true);
    expect(w.log.all().some(ev => ev.kind === 'lightning' && ev.tile === forest)).toBe(true);
    expect(w.log.count).toBeGreaterThan(before);
    expect(w.trees.state[treeK]).toBe(TREE_STATE.STUMP);
    expect(w.tileState[forest]).toBe(TILE_STATE.FIRE);
    expect(w.fear[forest]).toBeGreaterThan(0.5);
    expect(w.fear[tileIndex(cx + 30, cz, t.size)]).toBe(0);
    for (let k = 0; k < 20; k++) w.step(); // fear fades once per second
    expect(w.fear[forest]).toBeLessThan(1);
  });
});

describe('rockslide', () => {
  it('plans analytic impact points and downhill corridors from a ridge', () => {
    const t = generateIsland(6);
    const plan = planRockslide(t, createRng(4), 1000);
    expect(plan.rocks.length).toBeGreaterThanOrEqual(EVENTS.rockslide.count[0]);
    expect(plan.rocks.length).toBeLessThanOrEqual(EVENTS.rockslide.count[1]);
    expect([TILE.HILL, TILE.MOUNTAIN]).toContain(t.type[plan.ridgeTile]);
    for (const r of plan.rocks) {
      expect(r.impactTick).toBeGreaterThan(1000);
      expect(r.impactTick).toBeLessThan(1000 + secs(10));
      expect(t.heightAt(r.impactX, r.impactZ)).toBeLessThanOrEqual(t.tileHeight(plan.ridgeTile) + 8);
      expect(r.corridor.length).toBeGreaterThanOrEqual(1);
      for (let k = 1; k < r.corridor.length; k++) expect(t.tileHeight(r.corridor[k])).toBeLessThanOrEqual(t.tileHeight(r.corridor[k - 1]) + 1e-6);
      expect(r.endTick).toBeGreaterThan(r.impactTick);
      expect(Number.isFinite(r.vx) && Number.isFinite(r.vz) && r.vy > 0).toBe(true);
    }
    const again = planRockslide(t, createRng(4), 1000);
    expect(again.rocks.map(r => [r.impactX, r.impactZ, r.corridor])).toEqual(plan.rocks.map(r => [r.impactX, r.impactZ, r.corridor]));
  });

  it('kills at the impact point and along the corridor, then leaves a boulder that clears', () => {
    const w = createWorld({ seed: 6 });
    w.debug('massKill');
    const plan = triggerRockslide(w, w.streams.events);
    expect(w.log.all().some(ev => ev.kind === 'rockslide')).toBe(true);
    const r = plan.rocks[0];
    const victim = w.spawn(SPECIES_ID.RABBIT, r.impactX, r.impactZ);
    const endTile = r.corridor[r.corridor.length - 1];
    const roller = w.spawn(SPECIES_ID.RABBIT, tileX(endTile, w.terrain.size) + 0.5, tileZ(endTile, w.terrain.size) + 0.5);
    const safe = w.spawn(SPECIES_ID.RABBIT, 2.5, 2.5);
    // Pin the subjects in place every tick: goals still run, so without this the victim
    // simply walks off the impact point before the rock lands.
    const pin = [[victim, r.impactX, r.impactZ], [roller, tileX(endTile, w.terrain.size) + 0.5, tileZ(endTile, w.terrain.size) + 0.5], [safe, 2.5, 2.5]];
    const freezeAll = () => {
      w.entities.forEachAlive(i => { w.entities.hunger[i] = 0.2; w.entities.thirst[i] = 0.2; w.entities.vx[i] = 0; w.entities.vz[i] = 0; });
      for (const [i, x, z] of pin) if (w.entities.alive[i]) { w.entities.x[i] = x; w.entities.z[i] = z; }
    };
    while (w.clock.tick <= r.endTick + 1) { freezeAll(); w.step(); }
    expect(w.entities.alive[victim]).toBe(0);
    expect(w.log.all().filter(ev => ev.kind === 'death' && ev.cause === DEATH_CAUSE.ROCKFALL).length).toBeGreaterThanOrEqual(1);
    expect(w.tileState[endTile]).toBe(TILE_STATE.BOULDER);
    expect(w.entities.alive[safe]).toBe(1);
    while (w.clock.tick <= r.endTick + secs(EVENTS.rockslide.boulderSeconds) + 2) { freezeAll(); w.step(); }
    expect(w.tileState[endTile]).toBe(TILE_STATE.NORMAL);
    expect(roller === roller).toBe(true);
  });

  it('is identical with cannon and null physics (kills come from the plan, not from contacts)', { timeout: 60_000 }, () => {
    const seed = 12;
    const a = createWorld({ seed, physics: createPhysics(CANNON, generateIsland(seed)) });
    const b = createWorld({ seed, physics: nullPhysics() });
    a.debug('rockslide'); b.debug('rockslide');
    a.debug('lightning'); b.debug('lightning');
    for (let k = 0; k < 20 * 90; k++) { a.step(); b.step(); }
    expect(a.stats().counts).toEqual(b.stats().counts);
    expect(a.log.all().map(ev => ev.text)).toEqual(b.log.all().map(ev => ev.text));
    expect(a.physics.propCount).toBeGreaterThan(0);
    a.physics.dispose();
  });
});

describe('world with natural events', () => {
  it('fires scheduled events over time and stays deterministic', { timeout: 60_000 }, () => {
    const a = createWorld({ seed: 9 }); const b = createWorld({ seed: 9 });
    for (let k = 0; k < 20 * 60 * 5; k++) { a.step(); b.step(); }
    const n = a.stats().naturalEvents;
    expect(n.lightning + n.rockslide).toBeGreaterThan(0);
    expect(n).toEqual(b.stats().naturalEvents);
    expect(a.stats().counts).toEqual(b.stats().counts);
    expect(a.log.count).toBe(b.log.count);
  });
});
