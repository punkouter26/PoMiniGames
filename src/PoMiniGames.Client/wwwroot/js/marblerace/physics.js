// physics.js — cannon-es world + materials for PoMarbleRace
// Sphere marbles, box floor/walls, sphere pegs/bumps, hinged turnstile paddles.
import * as CANNON from 'cannon-es';

export const GRAVITY = 20;        // world gravity magnitude (down -Y)
export const FIXED_DT = 1 / 120;  // fixed physics step
export const MAX_SUBSTEPS = 8;

export function createWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  world.solver.iterations = 14;
  world.solver.tolerance = 0.001;
  world.defaultContactMaterial.friction = 0;

  // Frictionless track surface (the spec calls for a frictionless floor); restitution
  // is kept low on the floor/walls and higher on obstacles so marbles glance off.
  const marble = new CANNON.Material('marble');
  const surface = new CANNON.Material('surface');   // floor + walls
  const obstacle = new CANNON.Material('obstacle');  // paddles, pendulum boxes, plinko pins
  const rumble = new CANNON.Material('rumble');      // high-friction floor bands (subtle slow zones)
  const bump = new CANNON.Material('bump');          // washboard ridges — low bounce so they don't launch marbles
  const spinner = new CANNON.Material('spinner');    // Gauntlet rotors — the one surface that hits back

  world.addContactMaterial(new CANNON.ContactMaterial(marble, surface,
    { friction: 0.0, restitution: 0.12 }));
  world.addContactMaterial(new CANNON.ContactMaterial(marble, obstacle,
    { friction: 0.0, restitution: 0.40 }));
  world.addContactMaterial(new CANNON.ContactMaterial(marble, marble,
    { friction: 0.0, restitution: 0.45 }));
  // Rumble bands: enough friction to shave speed and reshuffle the pack, but the
  // floor is still steep so a marble slows — it never stops (non-blocking guarantee).
  world.addContactMaterial(new CANNON.ContactMaterial(marble, rumble,
    { friction: 0.38, restitution: 0.10 }));
  // Washboard ridges: bounce weakened 4× (0.40 → 0.10) so they jostle the pack
  // without launching marbles into the air.
  world.addContactMaterial(new CANNON.ContactMaterial(marble, bump,
    { friction: 0.0, restitution: 0.10 }));
  // Gauntlet rotors: high restitution so a motor-driven arm genuinely flings a marble
  // instead of shoving it. The bounce is the drama — this is the only contact in the
  // world tuned to make the outcome worse for whoever it hits.
  world.addContactMaterial(new CANNON.ContactMaterial(marble, spinner,
    { friction: 0.05, restitution: 0.62 }));

  return { world, materials: { marble, surface, obstacle, rumble, bump, spinner } };
}

export function stepWorld(world, dt) {
  // clamp dt so a stall/tab-switch can't explode the integrator
  world.step(FIXED_DT, Math.min(dt, 0.05), MAX_SUBSTEPS);
}
