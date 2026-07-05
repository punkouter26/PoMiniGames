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

  // Called once per KO. Snapshots current world transforms and primes
  // verlet velocities from a small impulse so the body doesn't sit motionless.
  activate(knockDir) {
    if (knockDir) this.knockDir.copy(knockDir).normalize();

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
const knockStrength = 7.0;        // horizontal push along knockDir
const splayStrength = 5.5;        // lateral push perpendicular to knockDir
const upKick = 0.4;               // small vertical so the body briefly arcs before falling
const downKick = -0.4;            // tiny downward push for low joints so gravity dominates
// Perpendicular to knockDir in the XZ plane.
const perpX = -this.knockDir.z;
const perpZ = this.knockDir.x;

// Upper body goes ALONG knockDir with a tiny vertical kick. Heavy on XZ,
// light on Y, so the figure tumbles forward (not up) and gravity lands
// it chest-down on the canvas.
this._impulse('hips',      this.knockDir.x * knockStrength, upKick, this.knockDir.z * knockStrength);
this._impulse('torso',     this.knockDir.x * (knockStrength * 0.7), upKick, this.knockDir.z * (knockStrength * 0.7));
this._impulse('head',      this.knockDir.x * (knockStrength * 1.4), upKick * 0.5, this.knockDir.z * (knockStrength * 1.4));
this._impulse('shoulderL', this.knockDir.x * (knockStrength * 0.5), upKick, this.knockDir.z * (knockStrength * 0.5));
this._impulse('shoulderR', this.knockDir.x * (knockStrength * 0.5), upKick, this.knockDir.z * (knockStrength * 0.5));
// Elbows splay OUTWARD perpendicular to knockDir + slight down. They
// land on either side of the torso instead of folding into the chest.
this._impulse('elbowL',    perpX * splayStrength, downKick, perpZ * splayStrength);
this._impulse('elbowR',    -perpX * splayStrength, downKick, -perpZ * splayStrength);
// Knees splay OUTWARD perpendicular to knockDir + slight down.
this._impulse('kneeL',     perpX * splayStrength, downKick, perpZ * splayStrength);
this._impulse('kneeR',     -perpX * splayStrength, downKick, -perpZ * splayStrength);

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

      // Splay bias: as a low joint nears the canvas, push it outward
      // perpendicular to the fall direction. Prevents the legs/arms
      // from clustering under the torso into a curled ball.
      if (p.pos.y < GROUND_Y + 0.6 && (p.name === 'kneeL' || p.name === 'kneeR'
                                     || p.name === 'elbowL' || p.name === 'elbowR')) {
        const sign = (p.name === 'kneeL' || p.name === 'elbowL') ? 1 : -1;
        const splayAccel = 12.0;
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
    }

    // Floor clamp with per-joint geometry extents.
    for (const [, p] of this.points) {
      const minY = jointMinY(p.name);
      if (p.pos.y < minY) p.pos.y = minY;
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