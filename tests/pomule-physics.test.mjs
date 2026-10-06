import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../src/PoMiniGames.Client/wwwroot/js/pomule/physics.js', import.meta.url), 'utf8');
const p = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const W = 1536, H = 512;
const avatar = (x, y, species = 7) => ({ x, y, species, mass: p.massOf(species), stamina: p.DASH_SECONDS, dashing: false, facing: 1 });

test('walking wraps east–west and stops at the poles', () => {
  const a = avatar(W - 2, 100);
  p.stepAvatar(a, { dx: 1, dy: 0 }, 0.1, W, H);
  assert.ok(a.x < 30, `wrapped to the west edge, got ${a.x}`);
  const b = avatar(100, p.RADIUS + 1);
  for (let i = 0; i < 20; i++) p.stepAvatar(b, { dx: 0, dy: -1 }, 0.1, W, H);
  assert.equal(b.y, p.RADIUS);
});

test('speed follows the food percentage, terrain and dash; diagonals are no faster', () => {
  const move = (input, factor) => { const a = avatar(500, 250); p.stepAvatar(a, input, 1, W, H, factor); return Math.hypot(a.x - 500, a.y - 250); };
  assert.equal(Math.round(move({ dx: 1, dy: 0 }, 1)), p.BASE_SPEED);
  assert.equal(Math.round(move({ dx: 1, dy: 0 }, 0.5)), p.BASE_SPEED / 2);
  assert.equal(Math.round(move({ dx: 1, dy: 1 }, 1)), p.BASE_SPEED);
  assert.equal(Math.round(move({ dx: 1, dy: 0, dash: true }, 1)), Math.round(p.BASE_SPEED * p.DASH_BOOST));
  assert.equal(p.terrainFactor(2, 7), 0.6, 'mountains slow a Humanoid');
  assert.equal(p.terrainFactor(2, 2), 1, 'but not an Ore-Gorger');
  assert.equal(p.terrainFactor(2, 6), 1, 'nor a Spheroid-Drifter');
  assert.equal(p.terrainFactor(1, 6), 1);
  assert.equal(p.terrainFactor(1, 7), 0.8);
});

test('dash stamina lasts three seconds, then refills slowly', () => {
  const a = avatar(500, 250);
  let dashedSteps = 0;
  for (let i = 0; i < 60; i++) {
    p.stepAvatar(a, { dx: 1, dy: 0, dash: true }, 0.1, W, H);
    if (a.dashing) dashedSteps++;
  }
  // Three seconds in the tank, plus the trickle that refills while out of breath.
  assert.ok(dashedSteps >= 30 && dashedSteps <= 37, `dashed ${dashedSteps} of 60 steps`);
  a.stamina = 0;
  p.stepAvatar(a, { dx: 1, dy: 0 }, 4, W, H);
  assert.equal(a.stamina, 1);
  assert.equal(p.stepStamina(p.DASH_SECONDS, false, 10), p.DASH_SECONDS, 'never above full');
});

test('two colonists of equal mass push each other apart equally', () => {
  const a = avatar(500, 250), b = avatar(510, 250);
  const bumps = p.resolveCollisions([a, b], W);
  assert.deepEqual(bumps, [{ a: 0, b: 1, dashA: false, dashB: false }]);
  assert.ok(Math.abs((b.x - a.x) - p.RADIUS * 2) < 1e-9, 'no longer overlapping');
  assert.ok(Math.abs((500 - a.x) - (b.x - 510)) < 1e-9, 'each moved the same distance');
});

test('Bonz-Crusher is never displaced and shoves the other colonist the whole way', () => {
  const bonz = avatar(500, 250, 5), other = avatar(510, 250);
  for (let i = 0; i < 50; i++) {
    other.x = 510;
    p.resolveCollisions([bonz, other], W);
    assert.equal(bonz.x, 500);
    assert.equal(bonz.y, 250);
  }
  assert.ok(Math.abs(other.x - (500 + p.RADIUS * 2)) < 1e-6);
});

test('collisions work across the seam, report who was dashing, and skip colonists in the pub', () => {
  const a = avatar(W - 4, 250), b = avatar(4, 250);
  a.dashing = true;
  assert.deepEqual(p.resolveCollisions([a, b], W), [{ a: 0, b: 1, dashA: true, dashB: false }]);
  assert.ok(a.x > W / 2 && b.x < W / 2, 'pushed apart across the seam, not across the planet');
  const c = avatar(500, 250), d = avatar(505, 250);
  d.out = true;
  assert.deepEqual(p.resolveCollisions([c, d], W), []);
  assert.equal(c.x, 500);
});

test('a M.U.L.E. trails its owner on the tether and bolts when it is stretched too far', () => {
  const owner = avatar(500, 250), mule = { x: 500 - p.TETHER, y: 250 };
  for (let i = 0; i < 30; i++) {
    p.stepAvatar(owner, { dx: 1, dy: 0 }, 0.05, W, H);
    assert.equal(p.stepTether(mule, owner, 0.05, W), false);
  }
  const gap = owner.x - mule.x;
  assert.ok(gap <= p.TETHER + 1 && gap > 0, `still on the tether, gap ${gap}`);
  owner.x += p.TETHER_SNAP + 50; // shoved clear across the map
  assert.equal(p.stepTether(mule, owner, 0.05, W), true);
});

test('steering takes the short way round and stops on arrival', () => {
  const a = avatar(W - 20, 250);
  const s = p.steerToward(a, 20, 250, W);
  assert.ok(s.dx > 0.99 && !s.arrived, 'east across the seam, not west across the planet');
  assert.equal(p.steerToward(avatar(100, 100), 103, 100, W).arrived, true);
});
