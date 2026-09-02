// noise.js — seeded value noise + fBm. Same integer hash as povoxelstrike/terrain.js
// (copied: that one is module-private and sim/ must not depend on another game).

function hash2(ix, iz, seed) {
  let h = (ix | 0) * 374761393 + (iz | 0) * 668265263 + (seed | 0) * 974634721;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Smoothstep-bilinear value noise in [0, 1]. */
export function valueNoise(x, z, seed) {
  const ix = Math.floor(x); const iz = Math.floor(z);
  const fx = smooth(x - ix); const fz = smooth(z - iz);
  const a = hash2(ix, iz, seed); const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed); const d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

/** Fractional Brownian motion, normalised to [0, 1]. */
export function fbm(x, z, seed, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0; let amp = 1; let norm = 0; let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * f, z * f, seed + o * 1013);
    norm += amp;
    amp *= gain; f *= lacunarity;
  }
  return sum / norm;
}
