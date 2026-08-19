// world.js — seeded arena build: Minecraft-style block terrain + scattered destructible
// structures (PRD §F3). Each structure gets a flattened build pad at its spot's height,
// so nothing floats over a slope or half-buries in a hillside; each placement is its own
// Structure instance with a private copy of the voxel grid, so two copies of one asset
// carve independently.

import * as THREE from 'three';
import { Structure } from './structure.js';
import { Terrain, ARENA_HALF } from './terrain.js';
import { builtinVolumes } from './buildings.js';

export { ARENA_HALF };

/** Deterministic PRNG so the same seed reproduces the same world (PRD §F3). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the world into `scene` + `physicsWorld`. Returns { structures, terrain }.
 * Falls back to procedural primitive volumes when no assets were ingested, so the game
 * is playable with an empty drop folder (PRD §F1/§F3).
 */
export function buildWorld(scene, physicsWorld, volumes, seed) {
  const rand = mulberry32(seed);
  const terrain = new Terrain(seed);
  terrain.flatten(0, 0, 10); // the player spawn pad

  // The map is always the built-in settlement (castle, keep, cottages, fort walls —
  // see buildings.js) PLUS every imported GLB asset. Choose every placement BEFORE
  // meshing the terrain — each spot flattens a build pad, and pads must be carved into
  // the heightmap before its static mesh is built. Big structures place first so the
  // castle always finds room.
  const sources = [...builtinVolumes(), ...volumes];
  const sized = sources.map(volume => {
    const [lo, hi] = volume.sizeRange ?? [8, 14]; // imports: comparable-building scale
    const target = lo + rand() * (hi - lo);
    const [imin, imax] = volume.instances ?? [1, 2];
    return { volume, target, count: imin + Math.floor(rand() * (imax - imin + 1)) };
  }).sort((a, b) => b.target - a.target);

  const placements = [];
  const placed = [];
  for (const { volume, target, count } of sized) {
    for (let i = 0; i < count; i++) {
      const maxDim = Math.max(...volume.dims);
      const scale = target / maxDim;
      const footprint = Math.max(volume.dims[0], volume.dims[2]) * scale;

      const spot = findSpot(rand, placed, footprint);
      if (!spot) continue; // arena is crowded — skip rather than overlap (min-spacing rule)

      placements.push({
        volume, scale, footprint,
        x: spot.x, z: spot.z,
        rotationY: Math.floor(rand() * 4) * Math.PI / 2,
      });
      placed.push({ x: spot.x, z: spot.z, r: footprint * 0.75 });
    }
  }

  for (const p of placements) {
    p.y = terrain.flatten(p.x, p.z, p.footprint * 0.8);
  }
  terrain.build(scene, physicsWorld);

  const structures = placements.map(p => new Structure(
    p.volume, p.scale, new THREE.Vector3(p.x, p.y, p.z), p.rotationY, scene, physicsWorld,
    terrain)); // terrain ref lets the stress solver notice undermining

  return { structures, terrain };
}

function findSpot(rand, placed, footprint) {
  const margin = ARENA_HALF - footprint;
  for (let attempt = 0; attempt < 40; attempt++) {
    const x = (rand() * 2 - 1) * margin;
    const z = (rand() * 2 - 1) * margin;
    // Keep the spawn area (origin) clear, and keep structures from interpenetrating.
    if (Math.hypot(x, z) < footprint * 0.75 + 10) continue;
    if (placed.every(p => Math.hypot(x - p.x, z - p.z) >= p.r + footprint * 0.75)) {
      return { x, z };
    }
  }
  return null;
}

// The old empty-drop-folder fallback trio (tower/wall/arch) is gone: buildings.js's
// settlement is always present, so the arena is never empty regardless of imports.
