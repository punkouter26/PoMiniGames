// rocks.js — rockslide boulders and volcanic projectiles: spheres with a launch velocity.
import { PROP_KIND } from '../core/config.js';

/**
 * spec: { x, y, z, count, speed, up?, spread? } — `speed` is the horizontal launch speed,
 * `up` the vertical component (default 2), `spread` the cone half-angle in radians.
 * Or spec: { rocks: [{ x, y, z, vx, vy, vz, big }] } for launches the sim already planned
 * (rockslides), so the bodies fly the same arcs the analytic kill rule used.
 */
export function spawnRocks(CANNON, world, material, filter, spec, rng, physicsCfg) {
  const out = [];
  const make = (radius, mass, x, y, z, vx, vy, vz, kind, sizeIndex) => {
    const body = new CANNON.Body({
      mass, material, shape: new CANNON.Sphere(radius),
      collisionFilterGroup: filter.group, collisionFilterMask: filter.mask,
      linearDamping: 0.05, angularDamping: 0.1,
      allowSleep: true, sleepSpeedLimit: physicsCfg.sleepSpeedLimit, sleepTimeLimit: physicsCfg.sleepTimeLimit,
    });
    body.position.set(x, y, z);
    body.velocity.set(vx, vy, vz);
    body.angularVelocity.set(rng.range(-3, 3), rng.range(-3, 3), rng.range(-3, 3));
    world.addBody(body);
    out.push({ body, kind, sizeIndex });
  };
  if (spec.rocks) {
    spec.rocks.forEach((r, k) => make(r.big ? 0.5 : 0.32, r.big ? 80 : 30, r.x + (rng.next() - 0.5) * 0.3, r.y + k * 0.05, r.z + (rng.next() - 0.5) * 0.3, r.vx, r.vy, r.vz, spec.projectile ? PROP_KIND.projectile : PROP_KIND.rock, r.big ? 7 : 6));
    return out;
  }
  const up = spec.up ?? 2;
  const baseAngle = spec.angle ?? rng.range(0, Math.PI * 2);
  const spread = spec.spread ?? Math.PI;
  for (let k = 0; k < spec.count; k++) {
    const big = rng.next() < 0.3;
    const radius = big ? 0.5 : 0.32;
    const body = new CANNON.Body({
      mass: big ? 80 : 30, material,
      shape: new CANNON.Sphere(radius),
      collisionFilterGroup: filter.group, collisionFilterMask: filter.mask,
      linearDamping: 0.05, angularDamping: 0.1,
      allowSleep: true, sleepSpeedLimit: physicsCfg.sleepSpeedLimit, sleepTimeLimit: physicsCfg.sleepTimeLimit,
    });
    const a = baseAngle + (rng.next() - 0.5) * spread;
    body.position.set(spec.x + (rng.next() - 0.5), spec.y + radius + k * 0.1, spec.z + (rng.next() - 0.5));
    body.velocity.set(Math.cos(a) * spec.speed, up + rng.next() * up, Math.sin(a) * spec.speed);
    body.angularVelocity.set(rng.range(-3, 3), rng.range(-3, 3), rng.range(-3, 3));
    world.addBody(body);
    out.push({ body, kind: spec.projectile ? PROP_KIND.projectile : PROP_KIND.rock, sizeIndex: big ? 7 : 6 });
  }
  return out;
}
