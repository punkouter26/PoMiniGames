// physics.js — cannon-es world + materials for PoMarbleRace
// Sphere marbles, box floor/walls, sphere pegs/bumps, hinged turnstile paddles.
import * as CANNON from 'cannon-es';

// Real-marble physics. The world is scaled at 1 unit = 1 cm, so a radius-1 marble is a 20 mm
// glass "shooter" (see marbles.js for the ~10.5 g mass that implies). Gravity is a weighty,
// natural fall — stronger than the old floaty arcade value but deliberately short of a literal
// 9.8 m/s² (which at this scale would be 981 u/s² and run the race ~8× faster). The floor now
// has real friction, so marbles ROLL down the chute (angular velocity coupling to linear) the
// way real marbles do, instead of the old frictionless slide.
export const GRAVITY = 72;        // world gravity magnitude (down -Y) — weighty, and enough to
                                  // keep pace once rolling friction scrubs speed on the turns
export const FIXED_DT = 1 / 120;  // fixed physics step
export const MAX_SUBSTEPS = 8;

export function createWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  // Friction now matters, and 101 marbles pile up a lot of simultaneous contacts, so give the
  // solver a couple more iterations to keep the rolling stable and jitter-free.
  world.solver.iterations = 16;
  world.solver.tolerance = 0.001;
  world.defaultContactMaterial.friction = 0.12;

  // Real glass marbles: they roll (surface friction couples spin to travel) and they're
  // bouncy on hard surfaces (glass has a high coefficient of restitution). The tuned values
  // below keep the chute's non-trapping guarantee: surface friction (0.2) stays below the
  // ramp's tan(slope) ≈ 0.45, so gravity always wins and a marble never rolls to rest.
  const marble = new CANNON.Material('marble');
  const surface = new CANNON.Material('surface');   // floor + walls
  const obstacle = new CANNON.Material('obstacle');  // paddles, pendulum boxes, plinko pins
  const rumble = new CANNON.Material('rumble');      // high-friction floor bands (slow zones)
  const bump = new CANNON.Material('bump');          // washboard ridges — low bounce so they don't launch marbles
  const spinner = new CANNON.Material('spinner');    // Gauntlet rotors — the one surface that hits back

  // Floor + walls: friction enough to induce rolling-without-slip on the ramp (needs to clear
  // (2/7)·tan(slope) ≈ 0.13), but no higher — every extra bit scrubs speed on the sharp turns.
  world.addContactMaterial(new CANNON.ContactMaterial(marble, surface,
    { friction: 0.18, restitution: 0.35 }));
  world.addContactMaterial(new CANNON.ContactMaterial(marble, obstacle,
    { friction: 0.25, restitution: 0.45 }));
  // Glass on glass is the bounciest contact in the world (COR ≈ 0.55 here), with a little
  // friction so a knock also imparts spin.
  world.addContactMaterial(new CANNON.ContactMaterial(marble, marble,
    { friction: 0.15, restitution: 0.55 }));
  // Rumble bands: extra friction to shave speed and reshuffle the pack, but kept below the
  // ramp's tan(slope) so a rolling marble slows without ever stopping (non-blocking guarantee).
  world.addContactMaterial(new CANNON.ContactMaterial(marble, rumble,
    { friction: 0.3, restitution: 0.12 }));
  // Washboard ridges: low bounce so they jostle the pack without launching marbles airborne.
  world.addContactMaterial(new CANNON.ContactMaterial(marble, bump,
    { friction: 0.2, restitution: 0.25 }));
  // Gauntlet rotors: high restitution so a motor-driven arm genuinely flings a marble instead
  // of shoving it. The bounce is the drama — the one contact tuned to make things worse.
  world.addContactMaterial(new CANNON.ContactMaterial(marble, spinner,
    { friction: 0.15, restitution: 0.6 }));

  return { world, materials: { marble, surface, obstacle, rumble, bump, spinner } };
}

export function stepWorld(world, dt) {
  // clamp dt so a stall/tab-switch can't explode the integrator
  world.step(FIXED_DT, Math.min(dt, 0.05), MAX_SUBSTEPS);
}
