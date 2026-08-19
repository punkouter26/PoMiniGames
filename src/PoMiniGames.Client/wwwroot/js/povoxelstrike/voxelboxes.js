// voxelboxes.js — turn a voxel grid into the smallest set of axis-aligned boxes that
// covers exactly its solid cells.
//
// This is the collision geometry for everything made of voxels. It replaces two much
// cruder approximations:
//
//   * structures used a FIXED 8-voxel grid — a box wherever any cell in an 8×8×8 block
//     was solid. At 0.25 m voxels that is a 2 m collision lattice over a 0.25 m wall, so
//     the hole you blasted was not the hole you could walk through, and shots and debris
//     collided with two metres of empty air around every opening;
//   * debris pieces used ONE box around the cluster's bounding volume, so an L-shaped
//     cornice tumbled and stacked like a rectangular brick.
//
// Greedy merging is what makes exactness affordable. An intact wall is a handful of
// boxes — often literally one — because the algorithm grows each box as far as it can on
// x, then y, then z before emitting it. Cost only appears where the shape is complicated,
// which is exactly where the approximation used to hurt.
//
// `maxBoxes` is a hard budget. Blowing it does not truncate the geometry (that would
// leave invisible gaps you could fall through); it retries at a coarser voxel granularity,
// which degrades toward the old behaviour instead of toward holes.

/**
 * @param cells Uint8Array, x-major then y then z (the layout every volume here uses)
 * @param dims [nx, ny, nz]
 * @param maxBoxes budget; exceeding it restarts at 2×, then 4×, … granularity
 * @returns { boxes: Float32Array of [cx,cy,cz, hx,hy,hz] per box, count, granularity }
 *   Centres and half-extents are in VOXEL units relative to the grid origin; the caller
 *   scales and offsets them.
 */
export function greedyBoxes(cells, dims, maxBoxes = 512) {
  for (let granularity = 1; granularity <= 8; granularity *= 2) {
    const result = tryGreedy(cells, dims, granularity, maxBoxes);
    if (result) return result;
  }
  // Last resort: one box around everything. Only reachable for a grid so intricate that
  // even 8-voxel blocks overflow the budget, which no asset in this game does.
  return {
    boxes: Float32Array.from([dims[0] / 2, dims[1] / 2, dims[2] / 2, dims[0] / 2, dims[1] / 2, dims[2] / 2]),
    count: 1,
    granularity: Math.max(...dims),
  };
}

function tryGreedy(cells, dims, g, maxBoxes) {
  const [nx, ny, nz] = dims;
  const gx = Math.ceil(nx / g), gy = Math.ceil(ny / g), gz = Math.ceil(nz / g);

  // Occupancy at this granularity: a coarse cell is solid if ANY voxel inside it is.
  // Erring toward solid is the right bias for a collider — a false-solid cell makes a
  // wall a few centimetres thick where it was thin, a false-empty one is a hole.
  const occ = new Uint8Array(gx * gy * gz);
  if (g === 1) {
    for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) occ[i] = 1;
  } else {
    for (let z = 0; z < nz; z++) {
      const cz = (z / g) | 0;
      for (let y = 0; y < ny; y++) {
        const cy = (y / g) | 0;
        const row = y * nx + z * nx * ny;
        for (let x = 0; x < nx; x++) {
          if (cells[row + x] !== 0) occ[((x / g) | 0) + cy * gx + cz * gx * gy] = 1;
        }
      }
    }
  }

  const out = [];
  const layer = gx * gy;
  for (let z = 0; z < gz; z++) {
    for (let y = 0; y < gy; y++) {
      for (let x = 0; x < gx; x++) {
        const start = x + y * gx + z * layer;
        if (occ[start] !== 1) continue;

        // Grow on x.
        let w = 1;
        while (x + w < gx && occ[start + w] === 1) w++;

        // Grow on y, requiring the whole w-run to be free.
        let h = 1;
        growY: while (y + h < gy) {
          const row = x + (y + h) * gx + z * layer;
          for (let i = 0; i < w; i++) if (occ[row + i] !== 1) break growY;
          h++;
        }

        // Grow on z, requiring the whole w×h slab.
        let d = 1;
        growZ: while (z + d < gz) {
          for (let j = 0; j < h; j++) {
            const row = x + (y + j) * gx + (z + d) * layer;
            for (let i = 0; i < w; i++) if (occ[row + i] !== 1) break growZ;
          }
          d++;
        }

        for (let k = 0; k < d; k++) {
          for (let j = 0; j < h; j++) {
            const row = x + (y + j) * gx + (z + k) * layer;
            for (let i = 0; i < w; i++) occ[row + i] = 2; // consumed
          }
        }

        // Back to voxel units, clamped to the real grid so a partly-filled coarse cell at
        // the far edge does not extend the collider past the model.
        const x0 = x * g, y0 = y * g, z0 = z * g;
        const x1 = Math.min(nx, (x + w) * g);
        const y1 = Math.min(ny, (y + h) * g);
        const z1 = Math.min(nz, (z + d) * g);
        out.push(
          (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
          (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2);

        if (out.length / 6 > maxBoxes) return null; // over budget: caller coarsens
      }
    }
  }
  return { boxes: Float32Array.from(out), count: out.length / 6, granularity: g };
}
