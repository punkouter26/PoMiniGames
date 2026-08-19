// physics.js — the simulation's units, materials and world factory.
//
// Everything in this game is now in SI: metres, kilograms, seconds, newtons, pascals.
// It was not before, and the three things that were wrong compounded into rubble that
// behaved like polystyrene:
//
//   * gravity was −20 m/s², twice Earth;
//   * debris mass was computed as volume × density and then DIVIDED BY 100, so every
//     falling chunk weighed 1 % of what it should, and was additionally capped at 500 kg
//     — a cap a single cubic metre of stone already exceeds;
//   * every material had the same 600 kg/m³ density, so slate, plaster and oak were
//     indistinguishable.
//
// The .pvx format has always carried per-material density, compressive and tensile
// strength, and every builtin volume declares them. Nothing read them. They are the
// input to the stress solver and the mass calculation now.
//
// Contact behaviour was the other half: the world had ZERO ContactMaterials, so stone,
// timber, soil and the player all shared cannon's default (friction 0.3, restitution 0).
// That is why rubble slid forever instead of grinding to a halt.

import * as CANNON from 'cannon-es';

export const GRAVITY = 9.81;              // m/s², positive magnitude
export const PHYSICS_STEP = 1 / 60;

/**
 * Real densities (kg/m³) and strengths (Pa). Compressive/tensile are the values that
 * decide when a wall crushes or a cantilever snaps, so they are the published figures for
 * the real material rather than round numbers: masonry runs 5–30 MPa compressive and is
 * roughly 10× weaker in tension, which is exactly why arches exist.
 */
export const MATERIAL_PRESETS = {
  stone: { density: 2400, compressive: 20e6, tensile: 2.0e6, kind: 'stone' },
  slate: { density: 2700, compressive: 25e6, tensile: 3.0e6, kind: 'stone' },
  brick: { density: 1900, compressive: 12e6, tensile: 1.2e6, kind: 'stone' },
  plaster: { density: 1400, compressive: 4e6, tensile: 0.5e6, kind: 'stone' },
  terracotta: { density: 2000, compressive: 9e6, tensile: 1.0e6, kind: 'stone' },
  wood: { density: 700, compressive: 35e6, tensile: 90e6, kind: 'wood' },
  soil: { density: 1600, compressive: 1e6, tensile: 0.05e6, kind: 'dirt' },
};

// Surface kinds the contact table is written against. A volume's material carries one.
export const SURFACES = ['stone', 'wood', 'dirt', 'player'];

/**
 * Build the physics world with SI gravity, a sweep-and-prune broadphase and the full
 * contact matrix. Returns { world, materials } where `materials` maps a surface kind to
 * its CANNON.Material — every body added to this world should be given one.
 */
export function createPhysicsWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
  world.allowSleep = true;
  // Sweep-and-prune, not the default naive broadphase: voxel shrapnel can put a couple
  // of hundred extra bodies in the world on top of the debris pieces, and naive is O(n²)
  // over every pair every step.
  world.broadphase = new CANNON.SAPBroadphase(world);
  // Real masses span four orders of magnitude now (a 0.25 m stone voxel is ~37 kg, a
  // collapsed tower section tens of tonnes). Large mass ratios are exactly what makes an
  // iterative solver spongy, so it gets more iterations and a tighter tolerance than the
  // default 10 / 1e-7 — this is the cost of using real units, paid deliberately.
  world.solver.iterations = 16;
  world.solver.tolerance = 1e-4;

  const materials = {};
  for (const kind of SURFACES) materials[kind] = new CANNON.Material(kind);

  // friction, restitution. Masonry on masonry is high-friction and almost perfectly
  // inelastic — a dropped block does not bounce, it thuds and stays put. Soil is higher
  // friction still and completely dead. Timber keeps a little life in it.
  const table = [
    ['stone', 'stone', 0.75, 0.04],
    ['stone', 'dirt', 0.85, 0.02],
    ['stone', 'wood', 0.55, 0.12],
    ['wood', 'wood', 0.45, 0.20],
    ['wood', 'dirt', 0.70, 0.06],
    ['dirt', 'dirt', 0.95, 0.00],
    // The player is deliberately frictionless against everything: movement is driven by
    // setting velocity directly, and any tangential friction against a wall reads to the
    // player as "stuck on the scenery" rather than as realism.
    ['player', 'stone', 0.0, 0.0],
    ['player', 'wood', 0.0, 0.0],
    ['player', 'dirt', 0.0, 0.0],
    ['player', 'player', 0.0, 0.0],
  ];
  for (const [a, b, friction, restitution] of table) {
    world.addContactMaterial(new CANNON.ContactMaterial(materials[a], materials[b], {
      friction, restitution,
      contactEquationStiffness: 1e8,
      contactEquationRelaxation: 3,
    }));
  }
  world.defaultContactMaterial.friction = 0.6;
  world.defaultContactMaterial.restitution = 0.05;

  return { world, materials };
}

/**
 * Resolve the material record for one voxel value of a volume.
 * `paletteMaterial[value - 1]` indexes into `materials[]`; both come straight out of the
 * .pvx file (or the builtin volume tables). Falls back to stone, which is what an asset
 * with no material table should behave as in a fortress.
 */
export function materialFor(volume, value) {
  const table = volume?.materials;
  if (!table || table.length === 0) return MATERIAL_PRESETS.stone;
  const index = volume.paletteMaterial ? (volume.paletteMaterial[value - 1] ?? 0) : 0;
  return table[Math.min(index, table.length - 1)] ?? MATERIAL_PRESETS.stone;
}

/**
 * Build the `materials` + `paletteMaterial` pair a volume needs from a per-colour list of
 * preset names. Presets are de-duplicated, so a wall with three shades of stone carries
 * ONE material entry and three palette slots pointing at it — which is what keeps the
 * stress solver's per-material lookups cheap.
 */
export function buildMaterialTable(kinds) {
  const materials = [];
  const index = new Map();
  const paletteMaterial = new Uint8Array(kinds.length);
  kinds.forEach((name, i) => {
    if (!index.has(name)) {
      index.set(name, materials.length);
      materials.push({ ...(MATERIAL_PRESETS[name] ?? MATERIAL_PRESETS.stone) });
    }
    paletteMaterial[i] = index.get(name);
  });
  return { materials, paletteMaterial };
}

/** Surface kind for a material record, for picking its CANNON.Material. */
export function surfaceOf(material) {
  return SURFACES.includes(material?.kind) ? material.kind : 'stone';
}

/**
 * Mass of a solid block of `voxelCount` voxels of edge `scale` metres.
 * No fudge factor and no cap: this is ρ·V, and a wall section really does weigh tonnes.
 */
export function massOf(voxelCount, scale, density) {
  return Math.max(0.05, voxelCount * scale * scale * scale * density);
}
