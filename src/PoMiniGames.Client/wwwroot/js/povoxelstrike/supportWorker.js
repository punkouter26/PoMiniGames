// supportWorker.js — the structural solve, off the main thread.
//
// Solving a carve is O(cells) and was measured at 24 ms on the castle and 127 ms on the
// largest imported piece. That ran inside the click handler, so every shot at a big wall
// dropped frames — the worst stutter in the game, and entirely CPU, not GPU.
//
// This module is deliberately dependency-free (no three, no cannon, no imports at all) so
// it can be loaded as a plain module worker. It receives a SNAPSHOT of a structure's cells
// and returns the indices that fail; the main thread owns the grid and applies the result.
//
// Applying a result computed from a slightly older snapshot is safe, and that is what
// makes the asynchrony sound rather than merely convenient: support only ever comes from
// material, so removing voxels can never ADD support. If a voxel was unsupported in the
// older, more-solid grid it is still unsupported now. A stale result can therefore only
// ever be incomplete, never wrong — and the next carve's solve catches the remainder.

self.onmessage = (e) => {
  const job = e.data;
  const failing = solve(job);
  // The failing list is transferred, not copied: a tower coming down is tens of thousands
  // of indices and this runs on every shot.
  self.postMessage({ id: job.id, generation: job.generation, failing }, [failing.buffer]);
};

function solve({ dims, cells, grounded, stepCost, crushStress, voxelWeight, scale, resolution }) {
  const [nx, ny, nz] = dims;
  const layer = nx * ny;
  const support = new Int16Array(cells.length).fill(-1);

  // ── Tension / bending: trace a load path up from the grounded columns ──
  const buckets = [];
  for (let i = 0; i <= resolution; i++) buckets.push([]);
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const i = x + z * layer; // y = 0
      if (cells[i] !== 0 && grounded[x + z * nx] === 1) {
        support[i] = resolution;
        buckets[resolution].push(i);
      }
    }
  }

  const relax = (x, y, z, s, bend) => {
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
    const i = x + y * nx + z * layer;
    const v = cells[i];
    if (v === 0) return;
    const next = bend ? s - stepCost[v] : s;
    if (next <= 0 || support[i] >= next) return;
    support[i] = next;
    buckets[next].push(i);
  };

  for (let s = resolution; s > 0; s--) {
    const bucket = buckets[s];
    for (let b = 0; b < bucket.length; b++) {
      const i = bucket[b];
      if (support[i] !== s) continue;
      const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / layer) | 0;
      relax(x, y + 1, z, s, false);   // straight up is pure compression: free
      relax(x + 1, y, z, s, true);
      relax(x - 1, y, z, s, true);
      relax(x, y, z + 1, s, true);
      relax(x, y, z - 1, s, true);
      relax(x, y - 1, z, s, true);    // hanging below
    }
    bucket.length = 0;
  }

  const failing = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== 0 && support[i] <= 0) failing.push(i);
  }

  // ── Compression: accumulate weight downward through what survived ──────
  const area = scale * scale;
  const load = new Float32Array(cells.length);
  for (let y = ny - 1; y >= 0; y--) {
    for (let z = 0; z < nz; z++) {
      const rowBase = y * nx + z * layer;
      for (let x = 0; x < nx; x++) {
        const i = rowBase + x;
        const v = cells[i];
        if (v === 0 || support[i] <= 0) continue;
        const carried = load[i] + voxelWeight[v];
        if (carried / area > crushStress[v]) { failing.push(i); continue; }
        if (y === 0) continue;
        const below = i - nx;
        if (cells[below] !== 0) { load[below] += carried; continue; }
        let n = 0;
        const cand = [];
        if (x > 0 && cells[below - 1] !== 0) { cand.push(below - 1); n++; }
        if (x < nx - 1 && cells[below + 1] !== 0) { cand.push(below + 1); n++; }
        if (z > 0 && cells[below - layer] !== 0) { cand.push(below - layer); n++; }
        if (z < nz - 1 && cells[below + layer] !== 0) { cand.push(below + layer); n++; }
        if (n === 0) continue; // hanging; the tension pass already judged it
        const share = carried / n;
        for (let k = 0; k < n; k++) load[cand[k]] += share;
      }
    }
  }

  return Int32Array.from(failing);
}
