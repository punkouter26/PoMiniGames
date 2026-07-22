// physics.js — the PoSports stride model. Pure functions, no DOM, no clock: every
// change is driven by tickLane(dt) so local play, AI lanes, and tests all share one
// deterministic engine.
//
// CONTRACT: the numeric constants below are mirrored in PoSportsConstants.cs — the
// server-authoritative sim for online races. PoSportsConstantsSyncTests parses this
// block (name: value pairs, one per line) and fails the build on drift. Change both
// sides in the same commit.
export const CONSTANTS = {
  IMPULSE: 3.8,          // m/s added per completed key sequence
  DECAY: 0.45,           // fraction of speed retained per second (v *= DECAY^dt)
  MAX_SPEED: 19,         // m/s cap
  JUMP_DURATION: 0.55,   // s airborne after a jump
  JUMP_DRAG: 0.85,       // impulse multiplier while airborne
  STUMBLE_FACTOR: 0.3,   // speed multiplier on a grounded hurdle hit
  STUMBLE_PENALTY: 1.5,  // s added to leg time per stumble
  FALSE_START_HOLD: 0.5, // s hold for typing before the gun
  SPRINT_LENGTH: 100,    // m
  HURDLES_LENGTH: 110,   // m
  INTERSTITIAL_SECONDS: 8, // s between legs (server-owned in online races)
  TICK: 0.016666666666666666, // 1/60 fixed step
};

/** Hurdle positions along the hurdles leg, meters from the start line. */
export const HURDLE_POSITIONS = [20, 30, 40, 50, 60, 70, 80, 90];

/** Duration the stumble (hit-react) animation locks the lane visual, seconds. */
export const STUMBLE_ANIM_SECONDS = 0.7;

/** A fresh lane state at the start line. */
export function createLane() {
  return {
    position: 0,       // m from the start line
    speed: 0,          // m/s
    legTime: 0,        // s elapsed on the current leg (incl. penalties)
    airborne: 0,       // s of jump remaining (0 = grounded)
    stumbling: 0,      // s of stumble anim remaining (visual lock only)
    holdUntil: 0,      // legTime before which impulses are ignored (false start)
    nextHurdle: 0,     // index into HURDLE_POSITIONS not yet resolved
    finished: false,
  };
}

/** Reset a lane for the next leg, keeping nothing but the object identity. */
export function resetLane(lane) {
  Object.assign(lane, createLane());
}

/** A completed key sequence: inject speed, honoring cap, air drag, and false-start hold. */
export function applyImpulse(lane) {
  if (lane.finished || lane.legTime < lane.holdUntil) return;
  const gain = lane.airborne > 0 ? CONSTANTS.IMPULSE * CONSTANTS.JUMP_DRAG : CONSTANTS.IMPULSE;
  lane.speed = Math.min(CONSTANTS.MAX_SPEED, lane.speed + gain);
}

/** Typing before the gun: hold the runner briefly. The caller resets sequence progress. */
export function applyFalseStart(lane) {
  lane.holdUntil = lane.legTime + CONSTANTS.FALSE_START_HOLD;
}

/** Start a jump if grounded. Returns whether the jump started. */
export function startJump(lane) {
  if (lane.finished || lane.airborne > 0) return false;
  lane.airborne = CONSTANTS.JUMP_DURATION;
  return true;
}

/**
 * Advance one lane by dt seconds. `hurdles` is [] for the sprint leg or
 * HURDLE_POSITIONS for the hurdles leg. Returns events: {stumbled, finished}.
 */
export function tickLane(lane, dt, hurdles, legLength) {
  const events = { stumbled: false, finished: false };
  if (lane.finished) return events;

  lane.legTime += dt;
  lane.speed *= Math.pow(CONSTANTS.DECAY, dt);
  if (lane.airborne > 0) lane.airborne = Math.max(0, lane.airborne - dt);
  if (lane.stumbling > 0) lane.stumbling = Math.max(0, lane.stumbling - dt);

  const prev = lane.position;
  lane.position += lane.speed * dt;

  // Hurdle resolution: a hurdle is cleared airborne or hit grounded, once each.
  while (lane.nextHurdle < hurdles.length && lane.position >= hurdles[lane.nextHurdle]) {
    if (lane.airborne <= 0) {
      lane.speed *= CONSTANTS.STUMBLE_FACTOR;
      lane.legTime += CONSTANTS.STUMBLE_PENALTY;
      lane.stumbling = STUMBLE_ANIM_SECONDS;
      events.stumbled = true;
    }
    lane.nextHurdle++;
  }

  if (prev < legLength && lane.position >= legLength) {
    lane.position = legLength;
    lane.finished = true;
    events.finished = true;
  }
  return events;
}
