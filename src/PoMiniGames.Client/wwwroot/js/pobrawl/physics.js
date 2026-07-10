// physics.js — cannon-es physics for PoBrawl.
//
// The character controllers are still authoritative for intent (move, attack,
// block). The physics world owns three concerns:
//
//   1. **Hurt bodies** — kinematic rig root + dynamic limb spheres connected
//      by `DistanceConstraint`. The rig root drives the sphere positions
//      each tick via the joint world-positions, and the constraint solver
//      keeps the spheres in valid capsule shape even under collision.
//
//   2. **Striker bodies** — dynamic spheres parented to the attacker's
//      active striker capsules. They are what actually registers hits via
//      cannon's `collide` event.
//
//   3. **Push-apart** — when two rig-root kinematic bodies come too close,
//      cannon-es pushes them apart naturally, replacing MIN_SEPARATION.
//
// Architecture follows marblerace/physics.js closely:
//   • `CANNON.World` with SAP broadphase and 14 solver iterations
//   • Fixed timestep of 1/120 driven by the engine's 1/60 SIM_DT step
//   • ContactMaterials named after the body kinds for tunable response
//
// Filter groups (mask math: group A & mask B → collisions if non-zero):
//   G_ROOT  = 1 << 0  (rig roots: kinematic, push-apart only)
//   G_HURT  = 1 << 1  (limb hurt spheres: dynamic, receive hits)
//   G_STRIKER = 1 << 2  (striker fist/foot spheres: dynamic, deal hits)
//   M_ALL   = G_ROOT | G_HURT | G_STRIKER

import * as CANNON from 'cannon-es';

export const G_ROOT = 1 << 0;
export const G_HURT = 1 << 1;
export const G_STRIKER = 1 << 2;
export const G_RAGDOLL = 1 << 3;  // KO rigid-body ragdoll parts
export const G_ARENA = 1 << 4;    // static ring colliders (posts, rope walls)
export const M_ALL = G_ROOT | G_HURT | G_STRIKER;

const GRAVITY = 20;
const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 8;

let _materials = null;

// Material instances are module-cached, but ContactMaterials must be
// registered on EVERY world (a rematch builds a fresh world — the old code
// only registered them for the first world ever created).
function ensureMaterials(world) {
  if (!_materials) {
    _materials = {
      root: new CANNON.Material('root'),
      hurt: new CANNON.Material('hurt'),
      striker: new CANNON.Material('striker'),
      ragdoll: new CANNON.Material('ragdoll'),
      arena: new CANNON.Material('arena'),
    };
  }
  const m = _materials;
  world.addContactMaterial(new CANNON.ContactMaterial(m.root, m.root, {
    friction: 0, restitution: 0,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(m.hurt, m.hurt, {
    friction: 0, restitution: 0.4,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(m.striker, m.hurt, {
    friction: 0.05, restitution: 0.2,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(m.striker, m.root, {
    friction: 0.05, restitution: 0.2,
  }));
  // KO ragdoll response: slight bounce off the canvas, high limb-on-limb
  // friction so the pile settles, springy rope walls.
  world.addContactMaterial(new CANNON.ContactMaterial(m.ragdoll, m.root, {
    friction: 0.5, restitution: 0.25,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(m.ragdoll, m.ragdoll, {
    friction: 0.4, restitution: 0.05,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(m.ragdoll, m.arena, {
    friction: 0.3, restitution: 0.45,
  }));
  return m;
}

// Build the shared physics world. One world per match.
export function createPhysicsWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  world.solver.iterations = 14;
  world.solver.tolerance = 0.001;
  world.defaultContactMaterial.friction = 0;
  const mats = ensureMaterials(world);
  // Floor at y = 0.04 to match the arena canvas.
  const floorBody = new CANNON.Body({
    mass: 0,
    material: mats.root,
    shape: new CANNON.Plane(),
  });
  floorBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
  floorBody.position.set(0, 0.04, 0);
  world.addBody(floorBody);
  return { world, materials: mats, floorBody };
}

// Step the world by a fixed 1/120 chunk. Called from game.js's _tick so it
// respects hit-pause (caller short-circuits on hitstopT > 0).
export function stepWorld(world, dt) {
  world.step(FIXED_DT, Math.min(dt, 0.05), MAX_SUBSTEPS);
}

// ── Rig-root kinematic body ───────────────────────────────────────────
// Used for push-apart between fighters. Mass=0 means cannon treats it as
// kinematic if we set `type = KINEMATIC` explicitly; otherwise static. We
// use kinematic so we can `body.position.copy(...)` per frame and have
// cannon-es compute proper contact response (push-apart) without us
// writing force back.
export function createRootBody(world, mats, initialPos) {
  const body = new CANNON.Body({
    mass: 0,
    material: mats.root,
    shape: new CANNON.Sphere(0.55),
    position: new CANNON.Vec3(initialPos.x, 0.9, initialPos.z),
    type: CANNON.Body.KINEMATIC,
  });
  body.collisionFilterGroup = G_ROOT;
  // Mask includes ragdolls: the standing winner shoves the KO'd body aside
  // (kinematic vs dynamic — only the ragdoll moves).
  body.collisionFilterMask = G_ROOT | G_RAGDOLL;
  body.userData = { kind: 'rigRoot' };
  world.addBody(body);
  return body;
}

// ── Static ring colliders ─────────────────────────────────────────────
// Posts + rope walls the KO ragdoll can crumple against and bounce off.
// They only interact with G_RAGDOLL, so live-fight bodies never see them.
export function buildArenaColliders(world, mats) {
  const HALF = 5.8;
  const bodies = [];
  const add = (body) => {
    body.collisionFilterGroup = G_ARENA;
    body.collisionFilterMask = G_RAGDOLL;
    body.userData = { kind: 'arena' };
    world.addBody(body);
    bodies.push(body);
  };
  // Corner posts.
  for (const x of [-HALF, HALF]) {
    for (const z of [-HALF, HALF]) {
      add(new CANNON.Body({
        mass: 0, material: mats.arena,
        shape: new CANNON.Cylinder(0.1, 0.1, 1.5, 8),
        position: new CANNON.Vec3(x, 0.79, z),
      }));
    }
  }
  // Rope walls: one thin springy box per side spanning the rope band
  // (y 0.45..1.35) so a launched body rebounds into the ring.
  for (const side of [0, 1]) {
    for (const sign of [-1, 1]) {
      add(new CANNON.Body({
        mass: 0, material: mats.arena,
        shape: new CANNON.Box(new CANNON.Vec3(
          side ? 0.04 : HALF, 0.45, side ? HALF : 0.04)),
        position: new CANNON.Vec3(side ? sign * HALF : 0, 0.9, side ? 0 : sign * HALF),
      }));
    }
  }
  return bodies;
}

// ── Hurt limb sphere ──────────────────────────────────────────────────
// A small dynamic sphere parented to one capsule endpoint. Two endpoints
// per capsule are joined by a `DistanceConstraint` so they track the
// capsule's joint positions. These are what the striker collides with.
//
// We model hurt limbs as DYNAMIC bodies with mass ~1 and modest linear/
// angular damping so cannon-es can resolve a small knockback impulse if
// a future hit registers directly here. For now the engine resolves
// defender knockback at the rig-root level (existing code).
export function createHurtSphere(world, mats, jointName, initialPos, radius = 0.18) {
  const body = new CANNON.Body({
    mass: 0.5,
    material: mats.hurt,
    shape: new CANNON.Sphere(radius),
    position: new CANNON.Vec3(initialPos.x, initialPos.y, initialPos.z),
    linearDamping: 0.4,
    angularDamping: 0.4,
  });
  body.collisionFilterGroup = G_HURT;
  body.collisionFilterMask = G_STRIKER | G_HURT;
  body.userData = { jointName, kind: 'hurt' };
  world.addBody(body);
  return body;
}

// DistanceConstraint between two hurt spheres — keeps them at the
// capsule's joint distance. cannon-es treats this as a stiff distance
// equality, so the spheres cannot drift apart during gameplay.
export function createDistanceConstraint(world, bodyA, bodyB, distance) {
  const c = new CANNON.DistanceConstraint(bodyA, bodyB, distance);
  world.addConstraint(c);
  return c;
}

// ── Striker fist/foot sphere ──────────────────────────────────────────
// One per active capsule (so up to 2 per swing). Bigger radius so they
// read as a real fist/foot. DYNAMIC so cannon's `collide` event fires
// when they touch a hurt sphere, and so they recoil on impact (force
// feedback for the attacker).
export function createStrikerSphere(world, mats, capsuleName, initialPos, radius = 0.22) {
  const body = new CANNON.Body({
    mass: 1.5,
    material: mats.striker,
    shape: new CANNON.Sphere(radius),
    position: new CANNON.Vec3(initialPos.x, initialPos.y, initialPos.z),
    linearDamping: 0.6,
    angularDamping: 0.6,
  });
  body.collisionFilterGroup = G_STRIKER;
  // G_STRIKER in the mask lets opposing strikers collide mid-air — the
  // engine turns striker-vs-striker contacts into parry clashes. Same-
  // fighter striker pairs are filtered out in the beginContact handler.
  body.collisionFilterMask = G_HURT | G_ROOT | G_STRIKER;
  body.userData = { capsuleName, kind: 'striker' };
  world.addBody(body);
  return body;
}

// Recoil helper: when a striker sphere hits a hurt body, we apply an
// opposing impulse to the striker so the attacker's limb visibly bounces
// off the defender. The defender knockback remains the engine's job
// (it computes attacker-mass-scaled knockback already).
export function applyRecoil(strikerBody, contactNormal) {
  if (!strikerBody || !contactNormal) return;
  const n = contactNormal;
  // Push back along the contact normal with a moderate impulse.
  const power = 4.5;
  strikerBody.applyImpulse(
    new CANNON.Vec3(-n.x * power, 1.5, -n.z * power),
    strikerBody.position
  );
}

// ── Fighter physics rig ───────────────────────────────────────────────
// Builds the cannon bodies for one fighter: kinematic rig-root + dynamic
// hurt spheres per capsule endpoint, joined by DistanceConstraints.
// Striker spheres are built on demand when an attack is active and
// destroyed when it ends (see attachStriker / detachStriker below).

import * as THREE from 'three';
import { FIGHTER_CAPSULES, ATTACK_CAPSULES } from './hitboxes.js';

const HURT_RADIUS_OVERRIDE = {
  head: 0.24, torso: 0.30,
  hipL: 0.16, hipR: 0.16,
  thighL: 0.14, thighR: 0.14,
  shinL: 0.12, shinR: 0.12,
  upperArmL: 0.12, upperArmR: 0.12,
  forearmL: 0.10, forearmR: 0.10,
};

export function buildFighterPhysics(world, mats, fighter, initialXZ) {
  const rigRoot = createRootBody(world, mats, { x: initialXZ.x, z: initialXZ.z });
  const hurtSpheres = [];
  const constraints = [];
  const _vA = new THREE.Vector3();
  const _vB = new THREE.Vector3();

  for (const [name, cap] of Object.entries(FIGHTER_CAPSULES.hurt)) {
    const aJoint = fighter.rig.joints[cap.jointA];
    const bJoint = fighter.rig.joints[cap.jointB];
    if (!aJoint || !bJoint) continue;
    aJoint.getWorldPosition(_vA);
    let sphereBPos;
    if (cap.anchorOffset) {
      sphereBPos = new THREE.Vector3(_vA.x, _vA.y - cap.anchorOffset, _vA.z);
    } else {
      bJoint.getWorldPosition(_vB);
      sphereBPos = _vB.clone();
    }
    const radius = HURT_RADIUS_OVERRIDE[name] ?? cap.radius;
    const sA = createHurtSphere(world, mats, `${name}:A`, _vA, radius);
    const sB = createHurtSphere(world, mats, `${name}:B`, sphereBPos, radius);
    hurtSpheres.push(sA, sB);
    // Distance constraint so the spheres track the capsule joint distance.
    const dist = _vA.distanceTo(sphereBPos);
    if (dist > 0.01) {
      constraints.push(createDistanceConstraint(world, sA, sB, dist));
    }
  }
  return { rigRoot, hurtSpheres, constraints };
}

// Drive all hurt spheres to their rig joint world positions. Called once
// per physics tick BEFORE world.step so the spheres start the tick in
// the right place.
export function syncHurtSpheres(fighter, hurtSpheres) {
  const _v = new THREE.Vector3();
  for (const s of hurtSpheres) {
    const tag = s.userData.jointName; // e.g. "head:A"
    const [capName, end] = tag.split(':');
    const cap = FIGHTER_CAPSULES.hurt[capName];
    if (!cap) continue;
    const joint = fighter.rig.joints[end === 'A' ? cap.jointA : cap.jointB];
    if (!joint) continue;
    joint.getWorldPosition(_v);
    s.position.set(_v.x, _v.y, _v.z);
    s.velocity.set(0, 0, 0);
    s.angularVelocity.set(0, 0, 0);
  }
}

// Drive kinematic rig-root to follow the fighter's XZ position. Y is
// pinned to 0.9 (mid-body height of the rig) so the kinematic sphere
// sits at the fighter's center of mass for stable push-apart.
export function syncRigRoot(rigRoot, fighter) {
  const p = fighter.rig.root.position;
  rigRoot.position.x = p.x;
  rigRoot.position.z = p.z;
  rigRoot.position.y = 0.9;
}

// ── Striker bodies (per-active-swing) ─────────────────────────────────
// Build two striker spheres at the active striker capsule endpoints,
// plus a distance constraint between them so they move together. Caller
// destroys them when the swing ends.
const _spherePos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _vA2 = new THREE.Vector3();
const _vB2 = new THREE.Vector3();

function strikerEndpointWorld(fighter, capsuleName, cap, endIsForward) {
  // Find the world position of one end of a striker capsule.
  const aJoint = fighter.rig.joints[cap.jointA];
  const bJoint = fighter.rig.joints[cap.jointB];
  if (!aJoint || !bJoint) return null;
  aJoint.getWorldPosition(_vA2);
  bJoint.getWorldPosition(_vB2);
  if (!endIsForward) return _vA2.clone();
  // Forward end: bJoint + forwardReach along fighter's facing direction.
  fighter.rig.root.getWorldDirection(_fwd);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
  _fwd.normalize();
  _spherePos.copy(_vB2).add(_fwd.clone().multiplyScalar(cap.forwardReach || 0));
  return _spherePos.clone();
}

export function buildSwingPhysics(world, mats, fighter, attackName, phase) {
  const set = ATTACK_CAPSULES[attackName];
  if (!set) return null;
  const target = phase === 'recover' ? set.recover : set.active;
  if (!target) return null;
  const spheres = [];
  const constraints = [];
  for (const [capName, cap] of Object.entries(target)) {
    const aPos = strikerEndpointWorld(fighter, capName, cap, false);
    const bPos = strikerEndpointWorld(fighter, capName, cap, true);
    if (!aPos || !bPos) continue;
    const sA = createStrikerSphere(world, mats, `${capName}:A`, aPos, cap.radius);
    const sB = createStrikerSphere(world, mats, `${capName}:B`, bPos, cap.radius);
    spheres.push(sA, sB);
    const dist = aPos.distanceTo(bPos);
    if (dist > 0.01) {
      constraints.push(createDistanceConstraint(world, sA, sB, dist));
    }
  }
  return { spheres, constraints };
}

export function syncStrikerSpheres(fighter, strikerSpheres, attackName, phase) {
  const set = ATTACK_CAPSULES[attackName];
  if (!set) return;
  const target = phase === 'recover' ? set.recover : set.active;
  if (!target) return;
  let i = 0;
  for (const [capName, cap] of Object.entries(target)) {
    const aPos = strikerEndpointWorld(fighter, capName, cap, false);
    const bPos = strikerEndpointWorld(fighter, capName, cap, true);
    if (!aPos || !bPos) continue;
    if (i + 1 >= strikerSpheres.length) break;
    strikerSpheres[i].position.set(aPos.x, aPos.y, aPos.z);
    strikerSpheres[i + 1].position.set(bPos.x, bPos.y, bPos.z);
    strikerSpheres[i].velocity.set(0, 0, 0);
    strikerSpheres[i].angularVelocity.set(0, 0, 0);
    strikerSpheres[i + 1].velocity.set(0, 0, 0);
    strikerSpheres[i + 1].angularVelocity.set(0, 0, 0);
    i += 2;
  }
}

// Tear down the per-swing striker bodies and constraints.
export function destroySwingPhysics(world, swing) {
  if (!swing) return;
  for (const c of swing.constraints || []) {
    if (world.constraints.includes(c)) world.removeConstraint(c);
  }
  for (const b of swing.spheres || []) {
    if (world.bodies.includes(b)) world.removeBody(b);
  }
}