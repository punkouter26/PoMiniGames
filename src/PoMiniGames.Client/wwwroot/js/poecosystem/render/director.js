// director.js — the auto-director: an idle camera that finds the island's drama on its own.
// Pure maths over the interpolated frame and the heightmap (no three.js, no DOM), so it
// can be unit-driven like playerController.js. It moves the same player pose the
// controller does; the renderer just asks it to take over the god between input steps.
//
// A shot is either a creature (orbit it, tracking as it moves) or a point (an event tile).
// Creatures are chosen by what they are doing — a hunt beats a graze — and every shot has
// a time limit so a quiet island still cuts around. Any real input hands control back.
import { FRAME } from '../sim/frame.js';
import { GOAL, GOAL_NAMES } from '../sim/behavior/utility.js';

const TAU = Math.PI * 2;
export const DIRECTOR = Object.freeze({
  shotSeconds: 14,
  eventSeconds: 9,
  orbitRate: 0.11,          // radians per second the camera circles its subject
  creatureRadius: 8,
  creatureHeight: 3.2,
  eventRadius: 24,
  eventHeight: 13,
  ease: 1.8,                // exponential follow rate once a shot is established
  cutEase: 7,               // faster for the first moments after a cut
  minClearance: 2.2,        // metres above the ground the camera never dips below
});

// What makes a creature worth watching. Anything unlisted is background.
const PRIORITY = {
  [GOAL.HUNT]: 6, [GOAL.FLEE]: 5, [GOAL.BUILD]: 4, [GOAL.MATE]: 3, [GOAL.CHOP]: 3,
  [GOAL.FOLLOW_PARENT]: 2, [GOAL.EAT]: 1, [GOAL.DRINK]: 1,
};

const lerpAngle = (a, b, t) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return a + d * t; };

export function createDirector({ onSubject = () => {}, onCaption = () => {}, random = Math.random } = {}) {
  let enabled = false;
  let shot = null;
  let angle = 0;
  let justCut = 0;      // seconds of fast easing left after a cut

  const rowOf = (handles, count, handle) => { for (let k = 0; k < count; k++) if (handles[k] === handle) return k; return -1; };

  function choose(interp, handles, count, now) {
    if (count === 0) { shot = null; return; }
    let best = -1; let bestScore = -1;
    for (let k = 0; k < count; k++) {
      const goal = interp[k * FRAME.CREATURE_STRIDE + 6] | 0;
      // Random jitter breaks ties so the same rabbit is not chosen every time.
      const score = (PRIORITY[goal] ?? 0) + random() * 0.9;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    if (best < 0) { shot = null; return; }
    const goal = interp[best * FRAME.CREATURE_STRIDE + 6] | 0;
    shot = {
      kind: 'creature', handle: handles[best], until: now + DIRECTOR.shotSeconds,
      radius: DIRECTOR.creatureRadius, height: DIRECTOR.creatureHeight, caption: GOAL_NAMES[goal] ?? '',
    };
    angle = random() * TAU;
    justCut = 1.2;
    onSubject(shot.handle);
    onCaption(shot.caption);
  }

  return {
    get enabled() { return enabled; },
    get caption() { return shot?.caption ?? ''; },
    get subject() { return shot?.kind === 'creature' ? shot.handle : -1; },
    setEnabled(on) {
      if (enabled === !!on) return;
      enabled = !!on;
      shot = null;
      if (!enabled) { onSubject(-1); onCaption(''); }
    },
    /** Cut to a world point (an event tile) for a while. Ignored while off. */
    cut(x, z, caption, now) {
      if (!enabled) return;
      shot = { kind: 'point', x, z, until: now + DIRECTOR.eventSeconds, radius: DIRECTOR.eventRadius, height: DIRECTOR.eventHeight, caption };
      angle = random() * TAU;
      justCut = 1.2;
      onSubject(-1);
      onCaption(caption);
    },
    /**
     * Drive the player pose toward the current shot. `now` in seconds. Returns false when
     * nothing was done (off, no terrain, or an empty island).
     */
    update(dt, now, { player, terrain, interp, handles, count }) {
      if (!enabled || !terrain) return false;
      let row = -1;
      if (shot?.kind === 'creature') row = rowOf(handles, count, shot.handle);
      if (!shot || now >= shot.until || (shot.kind === 'creature' && row < 0)) {
        choose(interp, handles, count, now);
        if (!shot) return false;
        row = shot.kind === 'creature' ? rowOf(handles, count, shot.handle) : -1;
        if (shot.kind === 'creature' && row < 0) { shot = null; return false; }
      }
      let tx; let ty; let tz;
      if (shot.kind === 'creature') { const o = row * FRAME.CREATURE_STRIDE; tx = interp[o]; ty = interp[o + 1]; tz = interp[o + 2]; }
      else { tx = shot.x; tz = shot.z; ty = terrain.heightAt(tx, tz); }

      angle += DIRECTOR.orbitRate * dt;
      const gx = tx + Math.sin(angle) * shot.radius;
      const gz = tz + Math.cos(angle) * shot.radius;
      const gy = Math.max(ty + shot.height, terrain.heightAt(gx, gz) + DIRECTOR.minClearance);
      const rate = justCut > 0 ? DIRECTOR.cutEase : DIRECTOR.ease;
      justCut = Math.max(0, justCut - dt);
      const k = Math.min(1, dt * rate);
      player.x += (gx - player.x) * k;
      player.y += (gy - player.y) * k;
      player.z += (gz - player.z) * k;

      const dx = tx - player.x; const dy = ty + 0.8 - player.y; const dz = tz - player.z;
      const yaw = Math.atan2(dx, dz);
      const pitch = Math.atan2(dy, Math.hypot(dx, dz) || 1e-6);
      const look = Math.min(1, dt * 4);
      player.yaw = lerpAngle(player.yaw, yaw, look);
      player.pitch += (pitch - player.pitch) * look;
      player.mode = 'fly';
      player.vy = 0;
      return true;
    },
  };
}
