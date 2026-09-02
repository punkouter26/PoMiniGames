// steering.js — velocity intents (seek / flee / wander) and the one integrator that
// moves a creature over the heightmap. Creatures are kinematic: no rigid body, just a
// walkability probe ahead with two fallback headings so they slide along coasts and
// cliffs instead of stopping dead.
import { BEHAVIOR } from '../core/config.js';
import { TILE_STATE, isWalkable, tileIndex } from '../terrain/tiles.js';

export function seekTo(e, i, tx, tz, speed) {
  const dx = tx - e.x[i]; const dz = tz - e.z[i];
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) { e.vx[i] = 0; e.vz[i] = 0; return; }
  e.vx[i] = dx / d * speed; e.vz[i] = dz / d * speed;
}

export function fleeFrom(e, i, fx, fz, speed) {
  const dx = e.x[i] - fx; const dz = e.z[i] - fz;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) { e.vx[i] = speed; e.vz[i] = 0; return; }
  e.vx[i] = dx / d * speed; e.vz[i] = dz / d * speed;
}

/** Persistent heading with jitter, from the behaviour RNG stream. */
export function wander(e, i, rng, speed) {
  e.yaw[i] += (rng.next() - 0.5) * BEHAVIOR.wanderTurn;
  e.vx[i] = Math.sin(e.yaw[i]) * speed;
  e.vz[i] = Math.cos(e.yaw[i]) * speed;
}

export function stop(e, i) { e.vx[i] = 0; e.vz[i] = 0; }

const blocked = (s) => s === TILE_STATE.LAVA || s === TILE_STATE.HUT || s === TILE_STATE.BOULDER;

export function isPassable(terrain, tileState, x, z) {
  if (x < 0.5 || z < 0.5 || x >= terrain.size - 0.5 || z >= terrain.size - 0.5) return false;
  const t = tileIndex(x, z, terrain.size);
  return isWalkable(terrain.type[t]) && !blocked(tileState[t]);
}

// Fallback headings tried when the straight line is blocked (radians; ± pairs).
const TURNS = [0.7854, -0.7854, 1.5708, -1.5708, 2.3562, -2.3562];

/** Integrate one step; returns true when the creature moved. */
export function moveCreature(e, i, terrain, tileState, dt) {
  const vx = e.vx[i]; const vz = e.vz[i];
  const speed = Math.hypot(vx, vz);
  if (speed < 1e-6) return false;
  let nx = e.x[i] + vx * dt; let nz = e.z[i] + vz * dt;
  if (!isPassable(terrain, tileState, nx, nz)) {
    const heading = Math.atan2(vx, vz);
    let found = false;
    for (const turn of TURNS) {
      const h = heading + turn;
      nx = e.x[i] + Math.sin(h) * speed * dt; nz = e.z[i] + Math.cos(h) * speed * dt;
      if (isPassable(terrain, tileState, nx, nz)) { found = true; e.yaw[i] = h; break; }
    }
    if (!found) { stop(e, i); return false; }
  } else {
    e.yaw[i] = Math.atan2(vx, vz);
  }
  e.x[i] = nx; e.z[i] = nz;
  e.y[i] = terrain.heightAt(nx, nz);
  return true;
}
