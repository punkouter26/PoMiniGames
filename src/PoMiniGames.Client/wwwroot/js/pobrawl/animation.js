// animation.js — procedural pose animation for the fighter rigs.
// A pose is a partial map { jointName: {x,y,z} } of Euler targets; a track is a timed
// sequence of poses. Each tick the animator resolves the target pose (transient track
// if one is playing, else the base stance), then layers overlays (idle bob, walk swing,
// hit-reaction lean, foot-IK hint) and damp-lerps every joint toward the result.

const GUARD = {
  torso: { x: 0.06, y: 0.18, z: 0 },
  head: { x: -0.05, y: -0.15, z: 0 },
  shoulderL: { x: -0.65, y: 0, z: 0.12 },
  shoulderR: { x: -0.75, y: 0, z: -0.12 },
  elbowL: { x: -1.25, y: 0, z: 0 },
  elbowR: { x: -1.3, y: 0, z: 0 },
  hipL: { x: -0.14, y: 0, z: 0 },
  hipR: { x: -0.1, y: 0, z: 0 },
  kneeL: { x: 0.28, y: 0, z: 0 },
  kneeR: { x: 0.24, y: 0, z: 0 },
};

const BLOCK = {
  torso: { x: 0.16, y: 0.05, z: 0 },
  head: { x: 0.1, y: 0, z: 0 },
  shoulderL: { x: -1.05, y: 0, z: 0.35 },
  shoulderR: { x: -1.1, y: 0, z: -0.35 },
  elbowL: { x: -2.1, y: 0, z: 0 },
  elbowR: { x: -2.15, y: 0, z: 0 },
  hipL: { x: -0.24, y: 0, z: 0 },
  hipR: { x: -0.2, y: 0, z: 0 },
  kneeL: { x: 0.45, y: 0, z: 0 },
  kneeR: { x: 0.4, y: 0, z: 0 },
};

const KO_POSE = {
  torso: { x: -0.7, y: 0, z: 0 },
  head: { x: -0.5, y: 0, z: 0 },
  shoulderL: { x: 0.2, y: 0, z: 0.6 },
  shoulderR: { x: 0.15, y: 0, z: -0.6 },
  elbowL: { x: -0.3, y: 0, z: 0 },
  elbowR: { x: -0.3, y: 0, z: 0 },
  hipL: { x: -0.05, y: 0, z: 0 },
  hipR: { x: -0.05, y: 0, z: 0 },
  kneeL: { x: 0.05, y: 0, z: 0 },
  kneeR: { x: 0.05, y: 0, z: 0 },
};

// Transient tracks: [pose, duration] segments. Durations align with the combat
// windup/active/recover windows in game.js.
const TRACKS = {
  punch: [
    [{ shoulderR: { x: -0.35, y: 0, z: -0.3 }, elbowR: { x: -1.7, y: 0, z: 0 }, torso: { x: 0.05, y: 0.45, z: 0 } }, 0.08],
    [{ shoulderR: { x: -1.5, y: 0, z: 0 }, elbowR: { x: -0.05, y: 0, z: 0 }, torso: { x: 0.12, y: -0.4, z: 0 }, head: { x: 0, y: 0.1, z: 0 } }, 0.10],
    [GUARD, 0.22],
  ],
  kick: [
    [{ hipR: { x: -0.55, y: 0, z: 0 }, kneeR: { x: 1.5, y: 0, z: 0 }, torso: { x: 0.12, y: 0.1, z: 0 } }, 0.12],
    [{ hipR: { x: -1.4, y: 0, z: 0 }, kneeR: { x: 0.08, y: 0, z: 0 }, torso: { x: -0.22, y: 0.05, z: 0 }, shoulderL: { x: -0.2, y: 0, z: 0.5 }, shoulderR: { x: -0.2, y: 0, z: -0.6 } }, 0.12],
    [GUARD, 0.30],
  ],
  hitstun: [
    [{ torso: { x: -0.4, y: 0.1, z: 0 }, head: { x: -0.3, y: 0, z: 0 }, shoulderL: { x: 0.3, y: 0, z: 0.5 }, shoulderR: { x: 0.25, y: 0, z: -0.5 }, elbowL: { x: -0.4, y: 0, z: 0 }, elbowR: { x: -0.4, y: 0, z: 0 } }, 0.14],
    [GUARD, 0.21],
  ],
  ko: [
    [KO_POSE, 0.6],
  ],
};

function lerpAngle(cur, target, k) {
  return cur + (target - cur) * k;
}

export class Animator {
  constructor(joints) {
    this.joints = joints;
    this.track = null;
    this.trackT = 0;
    this.base = GUARD;
    this.walkPhase = 0;
    // Hit-reaction lean in radians (set by the game; decays each tick).
    this.leanX = 0;
    this.leanZ = 0;
    // Subtle foot-IK hint (set by the game when on the ground).
    this.footHint = { L: 0, R: 0 };
    // When true the animator stops driving joint rotations — used by the
    // ragdoll so its world-space solver isn't fought by the pose-lerp.
    this.frozen = false;
  }

  play(name) {
    this.track = TRACKS[name] || null;
    this.trackT = 0;
  }

  setBlocking(on) {
    this.base = on ? BLOCK : GUARD;
  }

  /** ctx: { dt, speed (0..1 walk amount), idleT (seconds), snappy (bool) } */
  update(ctx) {
    const { dt } = ctx;
    // When frozen, the ragdoll is in charge of joint transforms. Only the
    // walk-phase counter advances so a future unfreeze doesn't snap weirdly.
    if (this.frozen) {
      this.walkPhase += 0;
      return;
    }
    let target = this.base;
    let snappy = false;

    if (this.track) {
      this.trackT += dt;
      let t = this.trackT;
      let seg = null;
      for (const [pose, dur] of this.track) {
        if (t <= dur) { seg = pose; break; }
        t -= dur;
      }
      if (seg) {
        target = seg === GUARD ? GUARD : { ...GUARD, ...seg };
        snappy = true;
      } else {
        this.track = null;
      }
    }

    this.walkPhase += ctx.speed * dt * 9;
    const swing = Math.sin(this.walkPhase) * 0.55 * ctx.speed;
    const bob = Math.abs(Math.sin(this.walkPhase)) * 0.045 * ctx.speed
      + Math.sin(ctx.idleT * 2.2) * 0.015;

    const k = Math.min(1, dt * (snappy ? 24 : 12));
    for (const [name, joint] of Object.entries(this.joints)) {
      const pose = target[name] || { x: 0, y: 0, z: 0 };
      let px = pose.x, py = pose.y, pz = pose.z;

      // Walk-cycle overlay on limbs that aren't being driven by a transient track.
      if (!snappy && ctx.speed > 0.02) {
        if (name === 'hipL') px += swing;
        else if (name === 'hipR') px -= swing;
        else if (name === 'kneeL') px += Math.max(0, swing) * 0.8;
        else if (name === 'kneeR') px += Math.max(0, -swing) * 0.8;
        else if (name === 'shoulderL') px -= swing * 0.4;
        else if (name === 'shoulderR') px += swing * 0.4;
      }

      // Hit-reaction lean overlay on the upper body only.
      if (name === 'torso') { px += this.leanX; pz += this.leanZ; }
      else if (name === 'head') { px += this.leanX * 0.6; pz += this.leanZ * 0.6; }
      else if (name === 'hips') { px += this.leanX * 0.4; }

      // Foot-IK hint: bias the knee forward when this leg is "planted" so the
      // foot reads as anchored rather than skating. Only on hips/knees of the
      // grounded leg, and only when not in a transient track.
      if (!snappy && name === 'kneeL') px += this.footHint.L;
      if (!snappy && name === 'kneeR') px += this.footHint.R;

      joint.rotation.x = lerpAngle(joint.rotation.x, px, k);
      joint.rotation.y = lerpAngle(joint.rotation.y, py, k);
      joint.rotation.z = lerpAngle(joint.rotation.z, pz, k);
      if (name === 'hips') joint.position.y = 1.0 + bob;
    }
  }

  // Apply a hit-lean impulse (radians, world-space). Decays internally next tick.
  applyLean(x, z) {
    this.leanX += x;
    this.leanZ += z;
    // Cap so consecutive hits don't rotate the torso beyond believable range.
    this.leanX = Math.max(-0.8, Math.min(0.8, this.leanX));
    this.leanZ = Math.max(-0.8, Math.min(0.8, this.leanZ));
  }

  decayLean(dt) {
    const k = 1 - Math.min(1, dt * 5);
    this.leanX *= k;
    this.leanZ *= k;
  }
}