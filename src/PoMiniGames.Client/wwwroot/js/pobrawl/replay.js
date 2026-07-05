// replay.js — ring buffer of per-tick fighter state used to play back the last few
// seconds after a KO. We deliberately keep the record tiny: positions, rotations,
// state, stateT, and the current clock. That's enough to drive the existing
// animation system without forcing the animator to become deterministic across
// rolling restarts.

const REPLAY_WINDOW_SEC = 4.0;
const REPLAY_TICK = 1 / 60;

export class ReplayBuffer {
  constructor() {
    this.frames = [];
    this.maxFrames = Math.ceil(REPLAY_WINDOW_SEC / REPLAY_TICK);
    this.recording = false;
  }

  start() {
    this.frames.length = 0;
    this.recording = true;
  }

  stop() { this.recording = false; }

  record({ clock, fighters }) {
    if (!this.recording) return;
    const snap = fighters.map((f) => ({
      id: f.playerId,
      x: f.rig.root.position.x,
      y: f.rig.root.position.y,
      z: f.rig.root.position.z,
      ry: f.rig.root.rotation.y,
      rx: f.rig.root.rotation.x,
      state: f.state,
      stateT: f.stateT,
      hp: f.hpCur ?? 100,
    }));
    this.frames.push({ clock, fighters: snap });
    if (this.frames.length > this.maxFrames) this.frames.shift();
  }

  // Returns an array of {clock, fighters} sampled uniformly over the buffer.
  // If `frames` is short, returns what we have. Down-samples to ~30 Hz output
  // so interpolation isn't necessary for our pose-lerp animator.
  snapshot(targetCount = 90) {
    if (this.frames.length === 0) return [];
    const stride = Math.max(1, Math.floor(this.frames.length / targetCount));
    const out = [];
    for (let i = 0; i < this.frames.length; i += stride) out.push(this.frames[i]);
    return out;
  }
}