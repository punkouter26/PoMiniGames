// greedymesh.js — voxel grid → merged triangle mesh.
//
// Structures used to emit one quad per exposed voxel face. At 0.25 m voxels that put
// ~2.3 M of the scene's ~3.3 M triangles into the fortress walls, almost all of them
// coplanar neighbours of an identical quad. The terrain has merged its faces since it was
// written; the buildings never did.
//
// Six sweeps, one per face direction. For each slice perpendicular to that direction, an
// exposed-face mask is built over the two in-plane axes and then merged into the largest
// rectangles of equal colour. A flat wall face 100 voxels across collapses from 10 000
// quads to one.
//
// `step` is the LOD control. At step = 1 the mesh is exact. Above that, the grid is
// sampled in step³ blocks (a block is solid if ANY voxel in it is) and the quads are
// step voxels wide, which is what distant chunks draw. Collision never uses this — the
// colliders are built from the real grid by voxelboxes.js — so LOD changes the picture
// and nothing else.

// Face directions. `corners` lists the four (a, b) pairs in the two in-plane axes, in the
// winding order that leaves the face front-facing outward; the sweep axis is implied by
// the normal. Order matches the per-voxel FACES table this replaces, so nothing flips.
const DIRECTIONS = [
  { // +X : plane at x+1, in-plane (y, z)
    normal: [1, 0, 0], axis: 0, plus: 1,
    corner: (s, a0, a1, b0, b1) => [
      [s + 1, a0, b0], [s + 1, a1, b0], [s + 1, a1, b1], [s + 1, a0, b1]],
  },
  { // -X : plane at x
    normal: [-1, 0, 0], axis: 0, plus: 0,
    corner: (s, a0, a1, b0, b1) => [
      [s, a0, b1], [s, a1, b1], [s, a1, b0], [s, a0, b0]],
  },
  { // +Y : plane at y+1, in-plane (x, z)
    normal: [0, 1, 0], axis: 1, plus: 1,
    corner: (s, a0, a1, b0, b1) => [
      [a0, s + 1, b0], [a0, s + 1, b1], [a1, s + 1, b1], [a1, s + 1, b0]],
  },
  { // -Y : plane at y
    normal: [0, -1, 0], axis: 1, plus: 0,
    corner: (s, a0, a1, b0, b1) => [
      [a0, s, b0], [a1, s, b0], [a1, s, b1], [a0, s, b1]],
  },
  { // +Z : plane at z+1, in-plane (x, y)
    normal: [0, 0, 1], axis: 2, plus: 1,
    corner: (s, a0, a1, b0, b1) => [
      [a1, b0, s + 1], [a1, b1, s + 1], [a0, b1, s + 1], [a0, b0, s + 1]],
  },
  { // -Z : plane at z
    normal: [0, 0, -1], axis: 2, plus: 0,
    corner: (s, a0, a1, b0, b1) => [
      [a0, b0, s], [a0, b1, s], [a1, b1, s], [a1, b0, s]],
  },
];

/**
 * @param opts.get (x, y, z) -> palette value, 0 for empty. Must read the WHOLE grid, not
 *   just this chunk: a face on a chunk border is only hidden if the neighbouring chunk's
 *   voxel is solid, and a chunk that cannot see its neighbours seals itself in a shell.
 * @param opts.min [x, y, z] first voxel of the region to emit (inclusive)
 * @param opts.max [x, y, z] last voxel + 1 (exclusive)
 * @param opts.palette RGBA bytes, 4 per entry; entry i describes value i+1
 * @param opts.offset [x, y, z] subtracted from every vertex (the grid's centring)
 * @param opts.step LOD stride in voxels, 1 = exact
 * @returns {{positions:number[], normals:number[], colors:number[]}|null}
 */
export function greedyMesh({ get, min, max, palette, offset = [0, 0, 0], step = 1 }) {
  const positions = [], normals = [], colors = [];
  const s = Math.max(1, step | 0);

  // Coarse sampler for LOD. Erring toward solid is right for a distant mesh: a false
  // solid is a slightly fatter silhouette, a false empty is a hole you can see through.
  const sample = s === 1 ? get : (x, y, z) => {
    for (let dz = 0; dz < s; dz++) {
      for (let dy = 0; dy < s; dy++) {
        for (let dx = 0; dx < s; dx++) {
          const v = get(x + dx, y + dy, z + dz);
          if (v !== 0) return v;
        }
      }
    }
    return 0;
  };

  for (const dir of DIRECTIONS) {
    const { axis, normal } = dir;
    // In-plane axes, in a fixed order per sweep axis so `corner` above can name them.
    const [ai, bi] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];

    const aCount = Math.ceil((max[ai] - min[ai]) / s);
    const bCount = Math.ceil((max[bi] - min[bi]) / s);
    if (aCount <= 0 || bCount <= 0) continue;
    const mask = new Int32Array(aCount * bCount);

    for (let sv = min[axis]; sv < max[axis]; sv += s) {
      // Build the exposed-face mask for this slice.
      let any = false;
      for (let bj = 0; bj < bCount; bj++) {
        for (let aj = 0; aj < aCount; aj++) {
          const p = [0, 0, 0];
          p[axis] = sv;
          p[ai] = min[ai] + aj * s;
          p[bi] = min[bi] + bj * s;
          const here = sample(p[0], p[1], p[2]);
          if (here === 0) { mask[aj + bj * aCount] = 0; continue; }
          const q = [p[0], p[1], p[2]];
          q[axis] = sv + (dir.plus ? s : -s);
          const there = sample(q[0], q[1], q[2]);
          mask[aj + bj * aCount] = there === 0 ? here : 0;
          if (there === 0) any = true;
        }
      }
      if (!any) continue;

      // Greedy rectangle merge over the mask.
      for (let bj = 0; bj < bCount; bj++) {
        for (let aj = 0; aj < aCount; aj++) {
          const value = mask[aj + bj * aCount];
          if (value === 0) continue;

          let w = 1;
          while (aj + w < aCount && mask[aj + w + bj * aCount] === value) w++;

          let h = 1;
          grow: while (bj + h < bCount) {
            for (let k = 0; k < w; k++) {
              if (mask[aj + k + (bj + h) * aCount] !== value) break grow;
            }
            h++;
          }

          for (let dh = 0; dh < h; dh++) {
            for (let dw = 0; dw < w; dw++) mask[aj + dw + (bj + dh) * aCount] = 0;
          }

          const a0 = min[ai] + aj * s;
          const a1 = Math.min(max[ai], a0 + w * s);
          const b0 = min[bi] + bj * s;
          const b1 = Math.min(max[bi], b0 + h * s);
          // The face plane sits one LOD step out, not one voxel, or a decimated mesh
          // would sink its far faces inside the silhouette it is standing in for.
          const plane = dir.plus ? sv + s - 1 : sv;

          const p = (value - 1) * 4;
          const r = palette[p] / 255, g = palette[p + 1] / 255, b = palette[p + 2] / 255;
          const quad = dir.corner(plane, a0, a1, b0, b1);
          for (const i of [0, 1, 2, 0, 2, 3]) {
            positions.push(
              quad[i][0] - offset[0], quad[i][1] - offset[1], quad[i][2] - offset[2]);
            normals.push(normal[0], normal[1], normal[2]);
            colors.push(r, g, b);
          }
        }
      }
    }
  }

  return positions.length === 0 ? null : { positions, normals, colors };
}
