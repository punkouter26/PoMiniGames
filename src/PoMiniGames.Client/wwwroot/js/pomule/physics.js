// PoMule avatar movement, collisions and the M.U.L.E. tether. Pure maths, no DOM and no
// imports, so tests/pomule-physics.test.mjs can load this file on its own. The world
// width is passed in rather than imported for the same reason.

export const RADIUS = 14;
export const BASE_SPEED = 190;      // px per second at 100% speed
export const DASH_BOOST = 1.6;
export const DASH_SECONDS = 3;      // stamina
export const DASH_REFILL = 0.25;    // stamina seconds regained per second
const WINDED_UNTIL = 0.5;
export const TETHER = 30;           // how far behind a M.U.L.E. trails
export const TETHER_SNAP = 90;      // stretched past this, it bolts
const IMMOVABLE = 1e9;

function wrap(x, w) { return ((x % w) + w) % w; }
function delta(from, to, w) { let d = wrap(to - from, w); if (d > w / 2) d -= w; return d; }

/** Bonz-Crusher (species 5) cannot be pushed; everyone else weighs the same. */
export function massOf(species) { return species === 5 ? IMMOVABLE : 1; }

/**
 * Terrain drag. Mountains (2) and rivers (1) slow walkers; Ore-Gorger (2) ignores
 * mountains and Spheroid-Drifter (6) ignores all of it.
 */
export function terrainFactor(terrain, species) {
  if (species === 6) return 1;
  if (terrain === 2) return species === 2 ? 1 : 0.6;
  if (terrain === 1) return 0.8;
  return 1;
}

/** Drains stamina while dashing, refills it otherwise. Returns the new stamina. */
export function stepStamina(stamina, dashing, dt) {
  return dashing ? Math.max(0, stamina - dt) : Math.min(DASH_SECONDS, stamina + dt * DASH_REFILL);
}

/**
 * Moves one avatar. `input` is a direction (-1..1 each axis) plus `dash`. The avatar wraps
 * east–west and stops at the polar edges.
 */
export function stepAvatar(a, input, dt, worldW, worldH, speedFactor = 1) {
  const len = Math.hypot(input.dx, input.dy);
  // Run dry and you are winded until half a second of stamina is back; otherwise holding
  // the key would stutter-dash on every refilled sliver.
  if (a.stamina <= 0) a.winded = true;
  else if (a.stamina >= WINDED_UNTIL) a.winded = false;
  a.dashing = !!input.dash && a.stamina > 0 && !a.winded && len > 0;
  a.stamina = stepStamina(a.stamina, a.dashing, dt);
  if (len > 0) {
    const v = BASE_SPEED * speedFactor * (a.dashing ? DASH_BOOST : 1);
    a.x = wrap(a.x + (input.dx / len) * v * dt, worldW);
    a.y = Math.min(worldH - RADIUS, Math.max(RADIUS, a.y + (input.dy / len) * v * dt));
    if (input.dx !== 0) a.facing = Math.sign(input.dx);
  }
  return a;
}

/** Unit direction from an avatar to a target, the short way round, and whether it has arrived. */
export function steerToward(a, tx, ty, worldW, arriveWithin = 6) {
  const dx = delta(a.x, tx, worldW), dy = ty - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= arriveWithin) return { dx: 0, dy: 0, arrived: true };
  return { dx: dx / dist, dy: dy / dist, arrived: false };
}

/**
 * Pushes overlapping avatars apart in proportion to the other's mass and reports each
 * contact once: { a, b, dashA, dashB } (indices into `avatars`). Avatars with `out` set
 * (in the pub, starving) are skipped.
 */
export function resolveCollisions(avatars, worldW) {
  const bumps = [];
  for (let i = 0; i < avatars.length; i++) {
    for (let j = i + 1; j < avatars.length; j++) {
      const a = avatars[i], b = avatars[j];
      if (a.out || b.out) continue;
      let dx = delta(a.x, b.x, worldW), dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      if (dist >= RADIUS * 2) continue;
      if (dist === 0) { dx = 1; dy = 0; dist = 1; }
      const overlap = RADIUS * 2 - dist;
      // An immovable colonist takes none of the push (exactly none, not a rounding error's
      // worth); two of them split it like anyone else.
      const fixedA = a.mass >= IMMOVABLE, fixedB = b.mass >= IMMOVABLE;
      const shareA = fixedA === fixedB ? 0.5 : fixedA ? 0 : 1;
      const shareB = 1 - shareA;
      a.x = wrap(a.x - (dx / dist) * overlap * shareA, worldW);
      a.y -= (dy / dist) * overlap * shareA;
      b.x = wrap(b.x + (dx / dist) * overlap * shareB, worldW);
      b.y += (dy / dist) * overlap * shareB;
      bumps.push({ a: i, b: j, dashA: !!a.dashing, dashB: !!b.dashing });
    }
  }
  return bumps;
}

/**
 * Trails a M.U.L.E. behind its owner. Returns true when the tether is stretched past
 * breaking (the owner was shoved or teleported), which the caller reports as a runaway.
 */
export function stepTether(mule, owner, dt, worldW) {
  const dx = delta(mule.x, owner.x, worldW), dy = owner.y - mule.y;
  const dist = Math.hypot(dx, dy);
  if (dist > TETHER_SNAP) return true;
  if (dist > TETHER) {
    const pull = Math.min(dist - TETHER, BASE_SPEED * DASH_BOOST * 1.5 * dt);
    mule.x = wrap(mule.x + (dx / dist) * pull, worldW);
    mule.y += (dy / dist) * pull;
  }
  return false;
}
