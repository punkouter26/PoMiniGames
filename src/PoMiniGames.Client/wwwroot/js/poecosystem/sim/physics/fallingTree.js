// fallingTree.js — a felled trunk: one box hinged to a static stump anchor for a moment
// (so it swings over like a real tree), then released to tumble and settle as a log.
import { PROP_KIND } from '../core/config.js';

const TRUNK_HALF = { x: 0.15, y: 1.3, z: 0.15 }; // matches PROP_SIZES[5] = [0.30, 2.60, 0.30]

export function spawnFallingTree(CANNON, world, material, filter, info, rng, physicsCfg) {
  const trunk = new CANNON.Body({
    mass: 40, material,
    shape: new CANNON.Box(new CANNON.Vec3(TRUNK_HALF.x, TRUNK_HALF.y, TRUNK_HALF.z)),
    collisionFilterGroup: filter.group, collisionFilterMask: filter.mask,
    linearDamping: 0.1, angularDamping: 0.2,
    allowSleep: true, sleepSpeedLimit: physicsCfg.sleepSpeedLimit, sleepTimeLimit: physicsCfg.sleepTimeLimit,
  });
  trunk.position.set(info.x, info.y + TRUNK_HALF.y, info.z);
  world.addBody(trunk);

  const anchor = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, collisionFilterGroup: 0, collisionFilterMask: 0 });
  anchor.position.set(info.x, info.y, info.z);
  world.addBody(anchor);

  // Fall direction (unit, horizontal). The hinge axis is perpendicular to it, signed so that
  // a positive swing carries the top of the trunk toward the fall direction (right-hand rule).
  let dx = info.dirX ?? 1; let dz = info.dirZ ?? 0;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) { dx = 1; dz = 0; } else { dx /= len; dz /= len; }
  const axis = new CANNON.Vec3(dz, 0, -dx);
  const hinge = new CANNON.HingeConstraint(anchor, trunk, {
    pivotA: new CANNON.Vec3(0, 0, 0), pivotB: new CANNON.Vec3(0, -TRUNK_HALF.y, 0), axisA: axis, axisB: axis, maxForce: 1e6,
  });
  world.addConstraint(hinge);
  // A shove at the crown in the fall direction tips it off the vertical; gravity does the
  // rest through the hinge. (Setting velocities directly fights the constraint solver.)
  const crown = new CANNON.Vec3(info.x, info.y + TRUNK_HALF.y * 2, info.z);
  const shove = 2.5 + rng.next();
  trunk.applyImpulse(new CANNON.Vec3(dx * trunk.mass * shove, 0, dz * trunk.mass * shove), crown);

  return { entry: { body: trunk, kind: PROP_KIND.log, sizeIndex: 5 }, anchor, hinge };
}

export function releaseTree(world, tree) {
  if (tree.hinge) { world.removeConstraint(tree.hinge); tree.hinge = null; }
  if (tree.anchor) { world.removeBody(tree.anchor); tree.anchor = null; }
}
