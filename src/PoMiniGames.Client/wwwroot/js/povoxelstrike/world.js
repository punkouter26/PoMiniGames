// world.js — seeded arena build: block terrain + THE FORTRESS.
//
// The arena is no longer a scattered settlement. It is one concentric fortress standing
// on a levelled plateau at the centre of the map:
//
//        outer curtain wall (bastions at 4 corners, gatehouse facing spawn)
//          └─ outer ward: castles, cottages, towers
//               └─ inner curtain wall (bastions, gate on the OPPOSITE side)
//                    └─ inner ward
//                         └─ great keep → the golden chalice
//
// The player spawns outside on +Z and wins by reaching the chalice. Every wall is a
// normal destructible Structure, so "break through" is literal: the layout only decides
// where the stone starts.
//
// The two gates are deliberately on opposite faces. A straight run from spawn to the
// vault does not exist — you either walk the long way around the outer ward under the
// guns, or you make your own door. That choice is the whole game.
//
// Placement is still seeded, so a seed reproduces the same ward furniture; the ring
// geometry itself is fixed, because a fortress whose walls move is not a fortress.

import * as THREE from 'three';
import { Structure } from './structure.js';
import { Terrain, ARENA_HALF } from './terrain.js';
import { builtinVolumes } from './buildings.js';
import {
  rampart, bastion, gatehouse, greatKeep, FORTRESS_SCALE,
  OUTER_HALF, INNER_HALF, WALL_HEIGHT_OUTER, WALL_HEIGHT_INNER,
  KEEP_HALF, KEEP_HEIGHT, SPAWN_Z,
} from './fortress.js';

export { ARENA_HALF };
export { SPAWN_Z };

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

// Structure voxel size is `scale` world units per cell, so the ONLY way to halve it
// without shrinking the building is to double the grid. REFINE splits every cell into
// REFINE³ children: same silhouette, same world size, voxels REFINE× smaller — which is
// what "smaller voxels" means for destruction granularity, since the debris/carve/stress
// stack all work in cells. Cost is REFINE³ cells and ~REFINE² exposed faces per
// structure, so this is the first knob to turn back to 1 if the frame rate suffers.
const REFINE = 2;

// The support solver is O(cells) per carve and re-runs on every hit, so an unbounded
// REFINE turns one shot at a big piece into a visible freeze. Measured: a 600 k-cell
// structure carves in ~24 ms, a 1.4 M-cell one in ~127 ms. Volumes whose REFINED size
// would clear this budget keep their original grid — in practice that is the great keep
// alone, which therefore has the coarsest voxels in the fortress (0.5 vs 0.25 units).
const REFINE_CELL_BUDGET = 1_200_000;

function refine(volume) {
  if (REFINE <= 1) return volume;
  const [nx, ny, nz] = volume.dims;
  if (nx * ny * nz * REFINE ** 3 > REFINE_CELL_BUDGET) return volume;
  const [mx, my, mz] = [nx * REFINE, ny * REFINE, nz * REFINE];
  const cells = new Uint8Array(mx * my * mz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const c = volume.cells[x + y * nx + z * nx * ny];
        if (c === 0) continue;
        for (let dz = 0; dz < REFINE; dz++) {
          for (let dy = 0; dy < REFINE; dy++) {
            const row = (x * REFINE) + (y * REFINE + dy) * mx + (z * REFINE + dz) * mx * my;
            for (let dx = 0; dx < REFINE; dx++) cells[row + dx] = c;
          }
        }
      }
    }
  }
  return { ...volume, dims: [mx, my, mz], cells };
}

/** World units per cell for a refined fortress piece — halves if refine() took it. */
function scaleFor(original, refined) {
  return FORTRESS_SCALE * (original.dims[0] / refined.dims[0]);
}

/**
 * Build the world into `scene` + `physicsWorld`.
 * @returns { structures, terrain, spawn, chaliceSpot, turretMounts }
 *   turretMounts are { position, structure } pairs for fortress.js to bolt guns onto.
 */
export function buildWorld(scene, physicsWorld, volumes, seed, physicsMaterials = null) {
  const rand = mulberry32(seed);
  const terrain = new Terrain(seed);

  // The fortress stands on a levelled plateau. Flattening BEFORE the mesh is built is
  // mandatory — pads are carved into the heightmap, and the static mesh is generated
  // from it once. A plateau (not per-building pads) is what makes the rings interlock:
  // two wall runs meeting at a corner have to agree on their base height to the voxel.
  const plateau = terrain.flatten(0, 0, OUTER_HALF + 12);
  terrain.flatten(0, SPAWN_Z, 8); // the spawn apron, so you do not start inside a hill

  const placements = [];
  const turretSpecs = [];

  // ── Ring walls ───────────────────────────────────────────────────────────
  // A side runs corner-to-corner minus the bastion footprints at each end. Rampart
  // volumes are authored along +X, so the two Z-facing sides get a quarter-turn.
  const buildRing = (half, height, bastionSize, gateSide, gunsPerSide) => {
    const run = half * 2 - bastionSize * 2;
    const thickness = height > 13 ? 5 : 4;
    const gateWidth = 18;
    const wing = (run - gateWidth) / 2;

    for (const side of ['+z', '-z', '+x', '-x']) {
      // Local axis: `along` runs down the wall, `out` points away from the centre.
      const rotationY = (side === '+x' || side === '-x') ? Math.PI / 2 : 0;
      const outward = side === '+z' || side === '+x' ? 1 : -1;
      const axis = side === '+z' || side === '-z' ? 'z' : 'x';
      const at = (offset) => (axis === 'z'
        ? { x: offset, z: outward * half }
        : { x: outward * half, z: offset });

      if (side === gateSide) {
        // Gate in the middle, a wing of wall on each shoulder.
        const g = at(0);
        placements.push({
          volume: gatehouse(gateWidth, height, thickness),
          x: g.x, z: g.z, rotationY, tag: 'gate',
        });
        for (const sign of [-1, 1]) {
          const w = at(sign * (gateWidth / 2 + wing / 2));
          placements.push({
            volume: rampart(wing, height, thickness),
            x: w.x, z: w.z, rotationY, tag: 'wall',
            guns: gunsPerSide ? [{ t: 0, height }] : null,
          });
        }
      } else {
        const w = at(0);
        placements.push({
          volume: rampart(run, height, thickness),
          x: w.x, z: w.z, rotationY, tag: 'wall',
          guns: Array.from({ length: gunsPerSide }, (_, i) => ({
            // Spread guns evenly along the run, never at the very ends where they would
            // sit inside a bastion.
            t: (i + 1) / (gunsPerSide + 1) - 0.5, height,
          })),
        });
      }
    }

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        placements.push({
          volume: bastion(bastionSize, height + 5),
          x: sx * half, z: sz * half, rotationY: 0, tag: 'bastion',
          guns: [{ t: 0, height: height + 5 }],
        });
      }
    }
  };

  // Outer gate faces spawn (+z). Inner gate faces AWAY (−z) — see the header note.
  buildRing(OUTER_HALF, WALL_HEIGHT_OUTER, 9, '+z', 2);
  buildRing(INNER_HALF, WALL_HEIGHT_INNER, 7, '-z', 1);

  // ── Great keep ───────────────────────────────────────────────────────────
  placements.push({
    volume: greatKeep(KEEP_HALF, KEEP_HEIGHT),
    x: 0, z: 0, rotationY: 0, tag: 'keep',
    guns: [{ t: 0, height: KEEP_HEIGHT - 4 }],
  });

  // ── Ward furniture: the "multiple castles and buildings" inside the walls ──
  // Built-in settlement volumes, sized down to fit their ward and placed on a jittered
  // ring so a seed still varies the interior without ever blocking a gate passage.
  const wards = [
    { radius: (OUTER_HALF + INNER_HALF) / 2, count: 10, span: OUTER_HALF - INNER_HALF - 6 },
    { radius: (INNER_HALF + KEEP_HALF) / 2, count: 5, span: INNER_HALF - KEEP_HALF - 5 },
  ];
  const builtins = builtinVolumes();
  let pick = 0;
  for (const ward of wards) {
    for (let i = 0; i < ward.count; i++) {
      const volume = builtins[pick++ % builtins.length];
      const [lo, hi] = volume.sizeRange ?? [8, 14];
      // Never wider than the ward it stands in, or a cottage straddles two walls.
      const target = Math.min(ward.span, lo + rand() * (hi - lo));
      const angle = (i / ward.count) * Math.PI * 2 + rand() * 0.4;
      const r = ward.radius + (rand() - 0.5) * (ward.span * 0.25);
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      // Keep both gate passages clear so there is always a walkable way in.
      if (Math.abs(x) < 12 && Math.abs(Math.abs(z) - OUTER_HALF) < 14) continue;
      if (Math.abs(x) < 12 && Math.abs(Math.abs(z) - INNER_HALF) < 12) continue;
      const maxDim = Math.max(...volume.dims);
      placements.push({
        volume, x, z, rotationY: Math.floor(rand() * 4) * Math.PI / 2,
        tag: 'ward', explicitScale: target / maxDim,
      });
    }
  }

  // Imported GLB assets are scattered as siege dressing OUTSIDE the walls, where they
  // cannot wall off a gate or bury the chalice.
  for (const volume of volumes) {
    const [lo, hi] = volume.sizeRange ?? [8, 14];
    const target = lo + rand() * (hi - lo);
    const maxDim = Math.max(...volume.dims);
    for (let i = 0; i < 2; i++) {
      // Retry rather than accept: the spawn apron is a narrow band of the ring, and a
      // crate dropped on it fills the entire first frame with one asset instead of the
      // fortress. Give up after a few tries and skip the copy.
      let x = 0, z = 0, ok = false;
      for (let attempt = 0; attempt < 12 && !ok; attempt++) {
        const angle = rand() * Math.PI * 2;
        const r = OUTER_HALF + 8 + rand() * (ARENA_HALF - OUTER_HALF - 16);
        x = Math.cos(angle) * r;
        z = Math.sin(angle) * r;
        ok = Math.hypot(x - 0, z - SPAWN_Z) > 26;
      }
      if (!ok) continue;
      placements.push({
        volume, x, z,
        rotationY: Math.floor(rand() * 4) * Math.PI / 2,
        tag: 'siege', explicitScale: target / maxDim,
      });
    }
  }

  // ── Realise ──────────────────────────────────────────────────────────────
  // Wall pads first, then the perimeter wall, then the mesh — the terrain mesh is built
  // exactly once and every heightmap edit has to land before it.
  for (const p of placements) {
    if (p.tag === 'ward' || p.tag === 'siege') {
      const maxDim = Math.max(...p.volume.dims);
      p.y = terrain.flatten(p.x, p.z, maxDim * p.explicitScale * 0.6);
    } else {
      p.y = plateau; // ring pieces share the plateau height by construction
    }
  }
  terrain.buildPerimeterWall();
  terrain.build(scene, physicsWorld, physicsMaterials?.dirt);

  const structures = [];
  for (const p of placements) {
    const refined = refine(p.volume);
    const scale = p.explicitScale !== undefined
      ? p.explicitScale * (p.volume.dims[0] / refined.dims[0])
      : scaleFor(p.volume, refined);
    const structure = new Structure(refined, scale, new THREE.Vector3(p.x, p.y, p.z),
      p.rotationY, scene, physicsWorld, terrain, physicsMaterials);
    structures.push(structure);

    for (const gun of p.guns ?? []) {
      // `t` is a fraction of the piece's own long axis, so the mount rides the rotation
      // instead of being re-derived per side.
      const long = refined.dims[0] * scale;
      const offset = new THREE.Vector3(gun.t * long, gun.height + 1.2, 0);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), p.rotationY);
      turretSpecs.push({
        position: new THREE.Vector3(p.x + offset.x, p.y + offset.y, p.z + offset.z),
        structure,
      });
    }
  }

  return {
    structures,
    terrain,
    spawn: new THREE.Vector3(0, terrain.heightAt(0, SPAWN_Z) + 0.9, SPAWN_Z),
    // The chalice stands on the vault floor at the exact centre of the keep.
    chaliceSpot: new THREE.Vector3(0, plateau + 1.1, 0),
    turretMounts: turretSpecs,
  };
}
