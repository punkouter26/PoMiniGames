// ragdoll.js — minimal verlet ragdoll for the PoBrawl primitive rig.
//
// PoBrawl's rig is a hierarchy of THREE.Group pivots (hips → torso → head,
// hips → hip → knee, torso → shoulder → elbow). On KO we sample each pivot's
// current world position, then integrate per-joint verlet positions under
// gravity while enforcing distance constraints back to the parent joint and
// to the root. The result is a believable flop: head whips forward, knees
// buckle, arms trail behind, the torso rolls onto the canvas.
//
// We deliberately avoid a full physics engine. The rig is small (~10 joints),
// the constraints are fixed (parent-child distances baked from the rig), and
// we only need this for ~1.5 s before the camera/replay phases take over.
//
// All positions are stored in WORLD space; each tick we re-derive local
// rotation/translation from world positions so the parent-child chain stays
// intact for the standard three.js transform.

import * as THREE from 'three';

// Bone name → local rest length from its parent. Captured by the activator
// from the live rig so we don't hard-code dimensions that may change.
const JOINTS = [
  // (jointName, parentName, restLenToParent, restLenToRoot, mass)
  ['hips',     null,     0,       0,    3.5], // root anchor
  ['torso',    'hips',   0.10,    0.10, 2.0],
  ['head',     'torso',  0.62,    0.72, 1.0],
  ['shoulderL','torso',  0.28,    0.62, 0.8],
  ['shoulderR','torso',  0.28,    0.62, 0.8],
  ['elbowL',   'shoulderL', 0.34, 0.96, 0.6],
  ['elbowR',   'shoulderR', 0.34, 0.96, 0.6],
  ['hipL',     'hips',   0.11,    0.11, 1.0],
  ['hipR',     'hips',   0.11,    0.11, 1.0],
  ['kneeL',    'hipL',   0.42,    0.53, 0.8],
  ['kneeR',    'hipR',   0.42,    0.53, 0.8],
];

// After integrating, we cap how far below the canvas a joint can drop.
// Canvas top is y=0.04 (arena.js). Only the lowest joints (knees, shins,
// fists) should ever touch the floor — pinning hips/torso/head to the
// canvas would compress the body to zero thickness.
const GROUND_Y = 0.04;

// Joints that should clamp against the ground. Anything not in this set
// is free to fall below the canvas visually (hidden under the rig) — the
// constraint solver will keep them in valid positions relative to their
// parents anyway.
const GROUND_COLLIDERS = new Set(['kneeL', 'kneeR', 'elbowL', 'elbowR']);

// Minimum world-Y each joint's *mesh geometry* must stay above so the
// rendered boxes never poke through the canvas. Measured from the joint's
// pivot to the bottom of the deepest mesh hanging from it (shoes under
// knees, fists under elbows, skull under head, upper arms under shoulders).
// Applied AFTER the constraint solver so the solver can't drag a parent
// joint below the floor when a child is grounded.
const JOINT_GROUND_OFFSET = {
  hips:     0.0,
  torso:    0.0,
  head:     0.13,   // skull extends 0.26/2 below head pivot
  shoulderL:0.30,   // upperArm + forearm + fist chain
  shoulderR:0.30,
  elbowL:   0.31,   // forearm + fist
  elbowR:   0.31,
  hipL:     0.0,
  hipR:     0.0,
  kneeL:    0.44,   // shin + shoe
  kneeR:    0.44,
};

// Min world-Y a joint can occupy (so its lowest mesh pixel stays at GROUND_Y).
function jointMinY(name) {
  return GROUND_Y + (JOINT_GROUND_OFFSET[name] ?? 0);
}

// Tunable damping. Higher = stiffer body (snaps to constraints faster).
// Lower = jellier (constraints pulled softly over multiple ticks).
const STIFFNESS = 0.92;

// Inertia retention factor: how much of last-frame velocity to keep. Lower =
// the body loses energy faster (settles quicker). Real corpses are 0.96-0.98;
// a fighter taking a hit should feel more damped than that.
const VELOCITY_DAMPING = 0.86;

// Gravity in world units / second².
const GRAVITY = -22;

// ── Anatomical cone limits ────────────────────────────────────────────────
// Each entry constrains the bone (parent → joint) to stay within `maxAngle`
// radians of a reference direction sampled from two other verlet points.
// This is what actually prevents the "fold into a ball" failure the old
// splay-impulse hack fought: knees can't tuck to the chest, the head can't
// fold under the torso, arms can't cross through the ribcage.
//   [jointName, refFrom, refTo, maxAngle]
const CONE_LIMITS = [
  ['head',   'hips',  'torso',     0.95], // neck follows the spine
  ['kneeL',  'torso', 'hips',      1.45], // thigh stays within ~83° of "down the spine"
  ['kneeR',  'torso', 'hips',      1.45],
  ['elbowL', 'torso', 'shoulderL', 2.80], // generous shoulder ROM, no full cross-fold
  ['elbowR', 'torso', 'shoulderR', 2.80],
];

// ── Inter-limb collision ──────────────────────────────────────────────────
// Approximate each major point as a sphere and push overlapping pairs apart
// so limbs can't interpenetrate while the body settles. Parent-child pairs
// are skipped (the distance constraint owns those).
const LIMB_RADII = {
  head: 0.20, torso: 0.24, hips: 0.22,
  shoulderL: 0.14, shoulderR: 0.14,
  elbowL: 0.12, elbowR: 0.12,
  kneeL: 0.14, kneeR: 0.14,
};
const LIMB_NAMES = Object.keys(LIMB_RADII);

// Scratch vectors for the cone-limit solver (module scope, no per-tick alloc).
const _refDir = new THREE.Vector3();
const _boneDir = new THREE.Vector3();
const _coneAxis = new THREE.Vector3();
const _coneQuat = new THREE.Quaternion();
const _corrected = new THREE.Vector3();

export class PoBrawlRagdoll {
  constructor(joints, root) {
    this.joints = joints;
    this.root = root;
    // Per-joint verlet state. Initialised in activate().
    this.points = new Map(); // jointName -> { pos, prev, mass }
    this.active = false;
    this.t = 0;
    // Direction of the knockout kick — used to bias initial velocities so the
    // body falls away from the attacker instead of straight down.
    this.knockDir = new THREE.Vector3(1, 0, 0);
    // The cached rest length map keyed by jointName for constraint solving.
    this._rest = {};
    this._restParent = {};
  }

  // Called once per KO (or knockdown). Snapshots current world transforms and
  // primes verlet velocities from a small impulse so the body doesn't sit
  // motionless.
  //
  // opts.velocity — the fighter's world velocity at the moment of the hit.
  //                 Carried into every point so someone knocked out mid-dash
  //                 tumbles with real momentum instead of dropping in place.
  // opts.scale    — impulse multiplier (< 1 for the softer knockdown flop).
  activate(knockDir, opts = {}) {
    if (knockDir) this.knockDir.copy(knockDir).normalize();
    const scale = opts.scale ?? 1;
    const bvx = opts.velocity ? opts.velocity.x * 0.9 : 0;
    const bvz = opts.velocity ? opts.velocity.z * 0.9 : 0;

    // Bake rest distances from the live rig. We re-derive local positions
    // and rotations every frame from world coords, so the rig's hierarchy
    // is preserved without us having to track it separately.
    const tmp = new THREE.Vector3();
    const tmpParent = new THREE.Vector3();
    this.points.clear();
    for (const [name, parent, _localLen, _rootLen, mass] of JOINTS) {
      const j = this.joints[name];
      if (!j) continue;
      j.getWorldPosition(tmp);
      this.points.set(name, {
        pos: tmp.clone(),
        prev: tmp.clone(),
        mass,
        name,
        parent,
      });
      // Distance constraint to the parent.
      if (parent && this.joints[parent]) {
        this.joints[parent].getWorldPosition(tmpParent);
        const dx = tmp.x - tmpParent.x;
        const dy = tmp.y - tmpParent.y;
        const dz = tmp.z - tmpParent.z;
        this._rest[name] = Math.hypot(dx, dy, dz);
        this._restParent[name] = parent;
      }
    }

    // Initial impulse: launch the upper body ALONG knockDir (mostly horizontal,
// with a tiny vertical kick) so it tumbles away from the attacker and
// falls forward instead of arcing up into a ball. Lower-body joints
// (elbows, knees) splay OUTWARD (perpendicular to knockDir) with a tiny
// downward kick so the limbs lay flat on either side of the torso.
//
// The previous version launched every joint upward, which combined with
// the constraint solver's distance-only enforcement collapsed the figure
// into a tight cluster under the chest.
const knockStrength = 7.0 * scale; // horizontal push along knockDir
const splayStrength = 5.5 * scale; // lateral push perpendicular to knockDir
const upKick = 0.4 * scale;        // small vertical so the body briefly arcs before falling
const downKick = -0.4;             // tiny downward push for low joints so gravity dominates
// Perpendicular to knockDir in the XZ plane.
const perpX = -this.knockDir.z;
const perpZ = this.knockDir.x;

// Upper body goes ALONG knockDir with a tiny vertical kick. Heavy on XZ,
// light on Y, so the figure tumbles forward (not up) and gravity lands
// it chest-down on the canvas. Every point additionally inherits the
// fighter's momentum (bvx/bvz) so the tumble carries the pre-hit motion.
this._impulse('hips',      this.knockDir.x * knockStrength + bvx, upKick, this.knockDir.z * knockStrength + bvz);
this._impulse('torso',     this.knockDir.x * (knockStrength * 0.7) + bvx, upKick, this.knockDir.z * (knockStrength * 0.7) + bvz);
this._impulse('head',      this.knockDir.x * (knockStrength * 1.4) + bvx, upKick * 0.5, this.knockDir.z * (knockStrength * 1.4) + bvz);
this._impulse('shoulderL', this.knockDir.x * (knockStrength * 0.5) + bvx, upKick, this.knockDir.z * (knockStrength * 0.5) + bvz);
this._impulse('shoulderR', this.knockDir.x * (knockStrength * 0.5) + bvx, upKick, this.knockDir.z * (knockStrength * 0.5) + bvz);
// Elbows splay OUTWARD perpendicular to knockDir + slight down. They
// land on either side of the torso instead of folding into the chest.
this._impulse('elbowL',    perpX * splayStrength + bvx, downKick, perpZ * splayStrength + bvz);
this._impulse('elbowR',    -perpX * splayStrength + bvx, downKick, -perpZ * splayStrength + bvz);
// Knees splay OUTWARD perpendicular to knockDir + slight down.
this._impulse('kneeL',     perpX * splayStrength + bvx, downKick, perpZ * splayStrength + bvz);
this._impulse('kneeR',     -perpX * splayStrength + bvx, downKick, -perpZ * splayStrength + bvz);

    // Root gets a matching linear push so the whole rig slides.
    this.root.position.x += this.knockDir.x * 0.05;
    this.root.position.z += this.knockDir.z * 0.05;
    this.root.userData.ragdollFalling = true;

    this.active = true;
    this.t = 0;
  }

  _impulse(name, vx, vy, vz) {
    const p = this.points.get(name);
    if (!p) return;
    // Verlet velocity is encoded in (pos - prev). To give a starting velocity
    // we shift prev backward.
    p.prev.x = p.pos.x - vx * (1 / 60);
    p.prev.y = p.pos.y - vy * (1 / 60);
    p.prev.z = p.pos.z - vz * (1 / 60);
  }

  // Called every render frame. dt is in seconds.
  //
  // Two-phase architecture:
  //
  //   Phase 1 — FLAIL (t < 0.6s): pure verlet ragdoll. Gravity + impulses +
  //             constraint solver drive the body from its KO-time pose
  //             downward. We compute and apply joint rotations that point
  //             each joint's -Y axis at its target world position, derived
  //             from the verlet positions.
  //
  //   Phase 2 — LAND (0.6s ≤ t < 1.4s): verlet keeps running so the body
  //             settles, but we ALSO smoothly translate root.y toward
  //             GROUND_Y - hipsLocalY (= -0.96) so the rendered hips
  //             pivot slides from standing height down onto the mat.
  //             Combined with the verlet-driven joint rotations this
  //             reads as "the body falls and lands flat" rather than
  //             "the body floats and pops prone".
  //
  //   Phase 3 — REST (t ≥ 1.4s): verlet stops, the captured pose is held
  //             in place with root.y on the canvas. Joint rotations are
  //             simply re-applied from the final verlet positions each
  //             tick so the body doesn't drift.
  step(dt) {
    if (!this.active) return;
    this.t += dt;

    // Clamp dt so a tab-switch hiccup doesn't tunnel the body through the floor.
    dt = Math.min(dt, 1 / 30);

    if (this.t < 1.4) {
      this._integrateVerlet(dt);
      this._solveConstraints();
    }
    // From here on, regardless of phase, we render the body from the
    // verlet positions + a phase-dependent root.y blend.
    this._renderFromVerlet();
  }

  // ── Partial-blend step: the hitstun "active ragdoll" ─────────────────
  // Integrates the verlet body and SLERPs the animator-driven rotation of
  // the UPPER-BODY joints toward the physics solution by `weight` — the
  // defender's torso/arms/head genuinely absorb the blow while the foot IK
  // keeps the legs planted. The rig root is never touched, and each point
  // is softly re-anchored to the live rig so gravity can't sag the pose
  // over the short hitstun window.
  static BLEND_JOINTS = new Set(['torso', 'head', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR']);

  blendStep(dt, weight) {
    if (!this.active || weight <= 0.001) return;
    this.t += dt;
    dt = Math.min(dt, 1 / 30);
    this._integrateVerlet(dt);
    this._solveConstraints();

    // Soft anchor: pull each verlet point 35 %/frame toward where the
    // animator actually put the joint this tick. High-frequency whip
    // survives; low-frequency gravity sag does not.
    const anchor = new THREE.Vector3();
    for (const [name, p] of this.points) {
      const joint = this.joints[name];
      if (!joint) continue;
      joint.getWorldPosition(anchor);
      p.pos.lerp(anchor, 0.35);
      p.prev.lerp(anchor, 0.35);
    }

    // Blend upper-body joint rotations toward the verlet solution.
    const _yAxis = new THREE.Vector3(0, -1, 0);
    const _dir = new THREE.Vector3();
    const _parentQ = new THREE.Quaternion();
    const _targetQ = new THREE.Quaternion();
    for (const [name, parentName] of Object.entries(this._restParent)) {
      if (!PoBrawlRagdoll.BLEND_JOINTS.has(name)) continue;
      const joint = this.joints[name];
      const parentJoint = this.joints[parentName];
      const p = this.points.get(name);
      const parentP = this.points.get(parentName);
      if (!joint || !parentJoint || !p || !parentP) continue;
      _dir.set(p.pos.x - parentP.pos.x, p.pos.y - parentP.pos.y, p.pos.z - parentP.pos.z);
      if (_dir.lengthSq() < 1e-8) continue;
      _dir.normalize();
      _targetQ.setFromUnitVectors(_yAxis, _dir);
      parentJoint.getWorldQuaternion(_parentQ);
      _targetQ.premultiply(_parentQ.invert());
      joint.quaternion.slerp(_targetQ, weight);
    }
  }

  // ── Phase 1 + 2: verlet integration, constraint solve, ground clamp ──
  _integrateVerlet(dt) {
    const damp = Math.pow(VELOCITY_DAMPING, dt * 60);
    for (const [, p] of this.points) {
      const vx = (p.pos.x - p.prev.x) * damp;
      const vy = (p.pos.y - p.prev.y) * damp;
      const vz = (p.pos.z - p.prev.z) * damp;
      p.prev.copy(p.pos);
      p.pos.x += vx;
      p.pos.y += vy + GRAVITY * dt * dt;
      p.pos.z += vz;

      // Small residual splay bias near the canvas. The cone limits and
      // inter-limb collision now do the anatomical work; this just nudges
      // the limbs to lie on either side of the torso.
      if (p.pos.y < GROUND_Y + 0.6 && (p.name === 'kneeL' || p.name === 'kneeR'
                                     || p.name === 'elbowL' || p.name === 'elbowR')) {
        const sign = (p.name === 'kneeL' || p.name === 'elbowL') ? 1 : -1;
        const splayAccel = 6.0;
        const perpX = -this.knockDir.z;
        const perpZ = this.knockDir.x;
        p.pos.x += sign * perpX * splayAccel * dt * dt;
        p.pos.z += sign * perpZ * splayAccel * dt * dt;
      }

      // Ground collision on the lowest joints.
      if (GROUND_COLLIDERS.has(p.name) && p.pos.y < GROUND_Y) {
        p.pos.y = GROUND_Y;
        const friction = 0.6;
        p.prev.x = p.pos.x - (p.pos.x - p.prev.x) * friction;
        p.prev.z = p.pos.z - (p.pos.z - p.prev.z) * friction;
      }
    }
  }

  _solveConstraints() {
    for (let pass = 0; pass < 3; pass++) {
      for (const [, p] of this.points) {
        if (!p.parent) continue;
        const parent = this.points.get(p.parent);
        if (!parent) continue;
        const rest = this._rest[p.name];
        if (!rest) continue;
        const dx = p.pos.x - parent.pos.x;
        const dy = p.pos.y - parent.pos.y;
        const dz = p.pos.z - parent.pos.z;
        const dist = Math.hypot(dx, dy, dz) || 1e-6;
        const diff = (dist - rest) / dist;
        const w1 = 1 / p.mass;
        const w2 = 1 / parent.mass;
        const wsum = w1 + w2;
        const k = STIFFNESS * diff;
        p.pos.x -= dx * k * (w1 / wsum);
        p.pos.y -= dy * k * (w1 / wsum);
        p.pos.z -= dz * k * (w1 / wsum);
        parent.pos.x += dx * k * (w2 / wsum);
        parent.pos.y += dy * k * (w2 / wsum);
        parent.pos.z += dz * k * (w2 / wsum);
      }
      this._applyConeLimits();
      this._collideLimbs();
    }

    // Floor clamp with per-joint geometry extents.
    for (const [, p] of this.points) {
      const minY = jointMinY(p.name);
      if (p.pos.y < minY) p.pos.y = minY;
    }
  }

  // Clamp each constrained bone back inside its anatomical cone. Softly
  // blended (0.6/pass) so the correction doesn't pop.
  _applyConeLimits() {
    for (const [name, refFrom, refTo, maxAng] of CONE_LIMITS) {
      const p = this.points.get(name);
      if (!p || !p.parent) continue;
      const parent = this.points.get(p.parent);
      const a = this.points.get(refFrom);
      const b = this.points.get(refTo);
      if (!parent || !a || !b) continue;

      _refDir.set(b.pos.x - a.pos.x, b.pos.y - a.pos.y, b.pos.z - a.pos.z);
      if (_refDir.lengthSq() < 1e-8) continue;
      _refDir.normalize();

      _boneDir.set(p.pos.x - parent.pos.x, p.pos.y - parent.pos.y, p.pos.z - parent.pos.z);
      const len = _boneDir.length();
      if (len < 1e-6) continue;
      _boneDir.divideScalar(len);

      const ang = Math.acos(THREE.MathUtils.clamp(_refDir.dot(_boneDir), -1, 1));
      if (ang <= maxAng) continue;

      _coneAxis.crossVectors(_refDir, _boneDir);
      if (_coneAxis.lengthSq() < 1e-8) continue;
      _coneAxis.normalize();
      _coneQuat.setFromAxisAngle(_coneAxis, maxAng);
      _corrected.copy(_refDir).applyQuaternion(_coneQuat).multiplyScalar(len);
      p.pos.x += (parent.pos.x + _corrected.x - p.pos.x) * 0.6;
      p.pos.y += (parent.pos.y + _corrected.y - p.pos.y) * 0.6;
      p.pos.z += (parent.pos.z + _corrected.z - p.pos.z) * 0.6;
    }
  }

  // Sphere-sphere push-apart between major points so limbs never
  // interpenetrate. Parent-child pairs are skipped (distance constraints
  // own those); the mass-weighted split keeps the torso stable while
  // light limbs give way.
  _collideLimbs() {
    for (let i = 0; i < LIMB_NAMES.length; i++) {
      const pi = this.points.get(LIMB_NAMES[i]);
      if (!pi) continue;
      for (let j = i + 1; j < LIMB_NAMES.length; j++) {
        const pj = this.points.get(LIMB_NAMES[j]);
        if (!pj) continue;
        if (pi.parent === pj.name || pj.parent === pi.name) continue;
        const dx = pj.pos.x - pi.pos.x;
        const dy = pj.pos.y - pi.pos.y;
        const dz = pj.pos.z - pi.pos.z;
        const minD = LIMB_RADII[pi.name] + LIMB_RADII[pj.name];
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq >= minD * minD || distSq < 1e-8) continue;
        const dist = Math.sqrt(distSq);
        const push = (minD - dist) / dist;
        const wi = 1 / pi.mass, wj = 1 / pj.mass;
        const wsum = wi + wj;
        pi.pos.x -= dx * push * (wi / wsum);
        pi.pos.y -= dy * push * (wi / wsum);
        pi.pos.z -= dz * push * (wi / wsum);
        pj.pos.x += dx * push * (wj / wsum);
        pj.pos.y += dy * push * (wj / wsum);
        pj.pos.z += dz * push * (wj / wsum);
      }
    }
  }

  // ── Render: drive the THREE rig from verlet positions + phase blend ──
  // root.y is smoothly translated from 0 (standing) to GROUND_Y - 1.0
  // (hips on canvas) over t ∈ [0.3s, 1.2s]. This is what makes the body
  // "fall to the ground" visually — the rig translation slides the
  // rendered hips pivot down to the canvas while the verlet-driven
  // joint rotations fold the upper body forward.
  _renderFromVerlet() {
    const hips = this.points.get('hips');
    if (!hips) return;
    const hipsLocalY = (this.joints.hips && this.joints.hips.position.y) || 0;

    this.root.position.x = hips.pos.x;
    this.root.position.z = hips.pos.z;
    // root.y blend: 0 until t=0.3s (body is falling), then linearly
    // slide to (GROUND_Y - hipsLocalY) = -0.96 by t=1.2s. This is the
    // animation that visually lowers the body onto the canvas.
    const dropProgress = THREE.MathUtils.clamp((this.t - 0.3) / 0.9, 0, 1);
    // Ease-out so the descent slows as it touches the mat.
    const eased = 1 - (1 - dropProgress) * (1 - dropProgress);
    this.root.position.y = THREE.MathUtils.lerp(0, GROUND_Y - hipsLocalY, eased);

    // Joint rotations: point each joint's local -Y axis at its target
    // world position relative to its parent. This works whether the
    // body is mid-fall (joints spread out) or at rest (joints lying flat).
    const _yAxis = new THREE.Vector3(0, -1, 0);
    const _desiredDir = new THREE.Vector3();
    const _parentWorldQuat = new THREE.Quaternion();
    for (const [name, parentName] of Object.entries(this._restParent)) {
      const joint = this.joints[name];
      const parentJoint = this.joints[parentName];
      const p = this.points.get(name);
      const parentP = this.points.get(parentName);
      if (!joint || !parentJoint || !p || !parentP) continue;
      _desiredDir.set(
        p.pos.x - parentP.pos.x,
        p.pos.y - parentP.pos.y,
        p.pos.z - parentP.pos.z
      );
      if (_desiredDir.lengthSq() < 1e-8) continue;
      _desiredDir.normalize();
      const desiredWorldQuat = new THREE.Quaternion().setFromUnitVectors(_yAxis, _desiredDir);
      parentJoint.getWorldQuaternion(_parentWorldQuat);
      joint.quaternion.copy(_parentWorldQuat.clone().invert().multiply(desiredWorldQuat));
    }

    // Floor clamp: only apply if the deficit is genuinely small (≤ 0.15).
    // Larger deficits mean the ragdoll has folded into a shape where a
    // limb has rotated below the canvas — clamping the whole rig up
    // would undo the "lying flat" intent. Trust the verlet positions.
    this.root.updateMatrixWorld(true);
    let lowestDeficit = 0;
    const probeWorldY = new THREE.Vector3();
    for (const [name, extent] of Object.entries(JOINT_GROUND_OFFSET)) {
      const joint = this.joints[name];
      if (!joint) continue;
      joint.getWorldPosition(probeWorldY);
      const meshBottom = probeWorldY.y - extent;
      if (meshBottom < GROUND_Y) {
        const deficit = GROUND_Y - meshBottom;
        if (deficit > lowestDeficit) lowestDeficit = deficit;
      }
    }
    if (lowestDeficit > 1e-4 && lowestDeficit <= 0.15) {
      this.root.position.y += lowestDeficit;
    }
  }

  // Hard cleanup when the round ends or the page is disposed.
  dispose() {
    this.points.clear();
    this.active = false;
    if (this.root && this.root.userData) this.root.userData.ragdollFalling = false;
  }
}