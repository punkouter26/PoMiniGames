// buildings.js — hand-built voxel structures that ALWAYS populate the arena, alongside
// whatever GLB imports the drop folder provides: a walled castle with corner towers and
// a gatehouse, cottages with pitched roofs, a lone keep tower, and fort wall segments.
//
// Each is a volume in the same shape decodePvx returns, so the whole destruction stack
// (stress solver, carving, debris, collision probes) treats them exactly like imports.
// They are deliberately HOLLOW — door openings are sized so the player fits through at
// the placed scale, and cutting a wall open reveals rooms, not solid fill.

import { buildMaterialTable } from './physics.js';

// Per-colour materials, so a cottage's plaster crumbles at a quarter of the load its
// timber frame carries and a slate roof weighs what slate weighs.
const KINDS = {
  castle: ['stone', 'stone', 'wood', 'slate'],
  keepTower: ['stone', 'stone', 'slate'],
  cottage0: ['plaster', 'wood', 'terracotta'],
  cottage1: ['brick', 'wood', 'slate'],
  fortWall: ['stone', 'stone', 'wood'],
};

// Instance counts are doubled from the original settlement (castle 1 → 2, everything
// else 1-2 → 2-4). findSpot's attempt budget was raised to match — at this density the
// old 40 tries ran out and structures silently vanished instead of being placed.
/** @returns volumes with sizeRange (world units for the longest axis) and instances [min,max]. */
export function builtinVolumes() {
  return [castle(), keepTower(), cottage(0), cottage(1), fortWall()];
}

function makeVol(name, nx, ny, nz, colors, sizeRange, instances, kinds) {
  const palette = new Uint8Array(colors.length * 4);
  colors.forEach(([r, g, b], i) => palette.set([r, g, b, 255], i * 4));
  const { materials, paletteMaterial } = buildMaterialTable(
    kinds ?? colors.map(() => 'stone'));
  return {
    name,
    dims: [nx, ny, nz],
    cells: new Uint8Array(nx * ny * nz),
    palette,
    paletteMaterial,
    materials,
    sizeRange,
    instances,
  };
}

function set(v, x, y, z, c) {
  const [nx, ny, nz] = v.dims;
  if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
  v.cells[x + y * nx + z * nx * ny] = c;
}

/** Inclusive box fill (c = 0 carves). */
function box(v, x0, y0, z0, x1, y1, z1, c) {
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(v, x, y, z, c);
}

/** Battlement teeth along one horizontal run (2-on / 2-off). */
function crenellate(v, y, c, points) {
  for (const [x, z, phase] of points) {
    if (Math.floor(phase / 2) % 2 === 0) { set(v, x, y, z, c); set(v, x, y + 1, z, c); }
  }
}

// ── The castle: curtain walls, four corner towers, gatehouse, central keep ──

function castle() {
  const S = 56, H = 24;
  const v = makeVol('Castle', S, H, S,
    [[168, 170, 178], [128, 132, 142], [104, 76, 48], [84, 88, 100]], // light stone, dark stone, wood, slate
    [30, 34], [2, 2], KINDS.castle);
  const LIGHT = 1, DARK = 2, WOOD = 3, SLATE = 4;
  const in0 = 4, in1 = S - 1 - 4, wallH = 9;

  // Curtain walls (thickness 2) with a dark stone footing course.
  box(v, in0, 0, in0, in1, wallH, in0 + 1, LIGHT);
  box(v, in0, 0, in1 - 1, in1, wallH, in1, LIGHT);
  box(v, in0, 0, in0, in0 + 1, wallH, in1, LIGHT);
  box(v, in1 - 1, 0, in0, in1, wallH, in1, LIGHT);
  box(v, in0, 0, in0, in1, 1, in0 + 1, DARK);
  box(v, in0, 0, in1 - 1, in1, 1, in1, DARK);
  box(v, in0, 0, in0, in0 + 1, 1, in1, DARK);
  box(v, in1 - 1, 0, in0, in1, 1, in1, DARK);

  // Battlements along all four wall tops.
  const teeth = [];
  for (let x = in0; x <= in1; x++) { teeth.push([x, in0, x], [x, in1, x]); }
  for (let z = in0; z <= in1; z++) { teeth.push([in0, z, z], [in1, z, z]); }
  crenellate(v, wallH + 1, DARK, teeth);

  // Corner towers: round-ish, taller than the walls, crenellated.
  for (const [cx, cz] of [[in0 + 1, in0 + 1], [in0 + 1, in1 - 1], [in1 - 1, in0 + 1], [in1 - 1, in1 - 1]]) {
    const r = 5, towerH = 16;
    for (let z = -r; z <= r; z++) {
      for (let x = -r; x <= r; x++) {
        const d2 = x * x + z * z;
        if (d2 > r * r) continue;
        const shell = d2 > (r - 2) * (r - 2);
        for (let y = 0; y <= towerH; y++) {
          if (y <= 1) set(v, cx + x, y, cz + z, DARK);      // solid footing disc
          else if (shell) set(v, cx + x, y, cz + z, LIGHT); // hollow shaft
          else set(v, cx + x, y, cz + z, 0);
        }
        set(v, cx + x, towerH, cz + z, SLATE);              // cap floor
        if (shell && (x + z + 20) % 2 === 0) {
          set(v, cx + x, towerH + 1, cz + z, DARK);
          set(v, cx + x, towerH + 2, cz + z, DARK);
        }
      }
    }
  }

  // Gatehouse on the +z wall: opening the player can walk through, wood door jambs.
  const gx = Math.floor(S / 2);
  box(v, gx - 3, 0, in1 - 1, gx + 3, 7, in1, 0);          // the opening
  box(v, gx - 4, 0, in1 - 1, gx - 4, 7, in1, WOOD);       // jambs
  box(v, gx + 4, 0, in1 - 1, gx + 4, 7, in1, WOOD);
  box(v, gx - 4, 8, in1 - 1, gx + 4, 8, in1, WOOD);       // lintel

  // Central keep: hollow, two tiers, slate roof rim.
  const k0 = gx - 8, k1 = gx + 8, keepH = 18;
  box(v, k0, 0, k0, k1, keepH - 4, k1, LIGHT);
  box(v, k0 + 2, 2, k0 + 2, k1 - 2, keepH - 5, k1 - 2, 0); // hollow it
  box(v, k0 + 3, 0, k0 + 3, k1 - 3, keepH, k1 - 3, LIGHT); // upper tier
  box(v, k0 + 5, keepH - 8, k0 + 5, k1 - 5, keepH - 1, k1 - 5, 0);
  box(v, k0 + 3, keepH, k0 + 3, k1 - 3, keepH, k1 - 3, SLATE);
  // Keep door facing the gate.
  box(v, gx - 2, 0, k1 - 3, gx + 2, 5, k1, 0);

  return v;
}

// ── The lone keep tower ────────────────────────────────────────────────────

function keepTower() {
  const S = 15, H = 30;
  const v = makeVol('Keep Tower', S, H, S,
    [[150, 152, 162], [116, 120, 130], [84, 88, 100]], [16, 20], [2, 4], KINDS.keepTower);
  const LIGHT = 1, DARK = 2, SLATE = 3;
  const c = Math.floor(S / 2), r = 6;

  for (let z = 0; z < S; z++) {
    for (let x = 0; x < S; x++) {
      const d2 = (x - c) * (x - c) + (z - c) * (z - c);
      if (d2 > r * r) continue;
      const shell = d2 > (r - 2) * (r - 2);
      for (let y = 0; y < H - 3; y++) {
        if (shell) set(v, x, y, z, y <= 1 ? DARK : LIGHT);
      }
      set(v, x, H - 4, z, SLATE); // cap floor
      if (shell && (x + z) % 2 === 0) { set(v, x, H - 3, z, DARK); set(v, x, H - 2, z, DARK); }
    }
  }
  // Door + window slits.
  box(v, c - 1, 0, c + r - 2, c + 1, 4, c + r, 0);
  for (const wy of [8, 14, 20]) box(v, c, wy, c - r, c, wy + 2, c - r + 2, 0);
  return v;
}

// ── Cottages (two palettes) ────────────────────────────────────────────────

function cottage(variant) {
  const W = 20, H = 15, D = 15;
  const palettes = [
    [[214, 196, 168], [104, 74, 46], [158, 74, 54]],  // plaster, timber, terracotta roof
    [[172, 148, 122], [84, 62, 40], [104, 108, 120]], // stone, dark timber, slate roof
  ];
  const v = makeVol(variant === 0 ? 'Cottage' : 'Stone Cottage', W, H, D,
    palettes[variant], [9, 12], [2, 4], variant === 0 ? KINDS.cottage0 : KINDS.cottage1);
  const WALL = 1, TIMBER = 2, ROOF = 3;
  const wallH = 7;

  box(v, 0, 0, 0, W - 1, wallH, D - 1, WALL);
  box(v, 1, 1, 1, W - 2, wallH, D - 2, 0); // hollow interior
  // Timber corner posts + footing.
  for (const [x, z] of [[0, 0], [0, D - 1], [W - 1, 0], [W - 1, D - 1]]) box(v, x, 0, z, x, wallH, z, TIMBER);
  box(v, 0, 0, 0, W - 1, 0, D - 1, TIMBER);
  // Pitched roof along X with a one-cell overhang.
  for (let step = 0; step <= Math.ceil(D / 2); step++) {
    const y = wallH + 1 + step;
    const z0 = step, z1 = D - 1 - step;
    if (z0 > z1 || y >= H) break;
    box(v, 0, y, z0, W - 1, y, z0, ROOF);
    box(v, 0, y, z1, W - 1, y, z1, ROOF);
    if (z1 - z0 <= 1) box(v, 0, y, z0, W - 1, y, z1, ROOF); // ridge
    // Gable ends fill.
    box(v, 0, y - 1, z0, 0, y - 1, z1, WALL);
    box(v, W - 1, y - 1, z0, W - 1, y - 1, z1, WALL);
  }
  // Door (front) + windows.
  box(v, Math.floor(W / 2) - 1, 0, D - 1, Math.floor(W / 2) + 1, 4, D - 1, 0);
  box(v, 3, 3, D - 1, 5, 5, D - 1, 0);
  box(v, W - 6, 3, D - 1, W - 4, 5, D - 1, 0);
  box(v, 3, 3, 0, 5, 5, 0, 0);
  box(v, W - 6, 3, 0, W - 4, 5, 0, 0);
  return v;
}

// ── Fort wall segment ──────────────────────────────────────────────────────

function fortWall() {
  const W = 44, H = 13, D = 7;
  const v = makeVol('Fort Wall', W, H, D,
    [[150, 152, 162], [116, 120, 130], [104, 76, 48]], [22, 26], [2, 4], KINDS.fortWall);
  const LIGHT = 1, DARK = 2, WOOD = 3;
  const wallH = 8;

  box(v, 0, 0, 2, W - 1, wallH, 4, LIGHT);
  box(v, 0, 0, 2, W - 1, 1, 4, DARK);
  for (let x = 0; x < W; x++) {
    if (Math.floor(x / 2) % 2 === 0) { set(v, x, wallH + 1, 2, DARK); set(v, x, wallH + 2, 2, DARK); set(v, x, wallH + 1, 4, DARK); set(v, x, wallH + 2, 4, DARK); }
  }
  // Arched gate in the middle with wood jambs.
  const gx = Math.floor(W / 2);
  box(v, gx - 3, 0, 2, gx + 3, 5, 4, 0);
  box(v, gx - 2, 6, 2, gx + 2, 6, 4, 0);
  box(v, gx - 4, 0, 2, gx - 4, 6, 4, WOOD);
  box(v, gx + 4, 0, 2, gx + 4, 6, 4, WOOD);
  return v;
}
