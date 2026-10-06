// PoMule world geometry: a 24×8 tile planet whose columns wrap. Pure maths, no DOM and no
// imports, so tests/pomule-world.test.mjs can load this file on its own.

export const COLS = 24;
export const ROWS = 8;
export const TILE = 64;
export const WORLD_W = COLS * TILE;
export const WORLD_H = ROWS * TILE;
export const TOWN_ROW = 3;
export const TOWN_COLS = [2, 8, 14, 20];

// Mirrors Terrain in PoMuleMap.cs.
export const PLAINS = 0, RIVER = 1, MOUNTAIN = 2, CRATER = 3, TOWN = 4;

// A town tile is three doors side by side: Outfitter, Pub, Assay Office.
export const OUTFITTER = 0, PUB = 1, ASSAY = 2;

/** Brings any x back onto the planet: leaving the east edge re-enters at the west. */
export function wrapX(x, width = WORLD_W) {
  return ((x % width) + width) % width;
}

/** Signed shortest east–west step from `from` to `to`, going round the seam when closer. */
export function wrapDelta(from, to, width = WORLD_W) {
  let d = wrapX(to - from, width);
  if (d > width / 2) d -= width;
  return d;
}

/** Where a world x lands on screen for a camera centred on camX. Continuous across the seam. */
export function screenX(worldX, camX, viewW, width = WORLD_W) {
  return viewW / 2 + wrapDelta(camX, worldX, width);
}

export function tileAt(x, y) {
  const col = Math.floor(wrapX(x) / TILE);
  const row = Math.min(ROWS - 1, Math.max(0, Math.floor(y / TILE)));
  return { col, row, index: row * COLS + col };
}

export function tileCenter(index) {
  return { x: (index % COLS) * TILE + TILE / 2, y: Math.floor(index / COLS) * TILE + TILE / 2 };
}

/** Columns to draw for a view, left to right, with the screen x of each one's left edge. */
export function visibleColumns(camX, viewW) {
  const out = [];
  const first = Math.floor((camX - viewW / 2) / TILE);
  const last = Math.floor((camX + viewW / 2) / TILE);
  for (let c = first; c <= last; c++) {
    out.push({ col: ((c % COLS) + COLS) % COLS, x: viewW / 2 + (c * TILE - camX) });
  }
  return out;
}

/** The town building under a point, or null: { town, kind }. */
export function buildingAt(x, y) {
  const t = tileAt(x, y);
  const town = TOWN_COLS.indexOf(t.col);
  if (t.row !== TOWN_ROW || town < 0) return null;
  const within = wrapX(x) - t.col * TILE;
  return { town, kind: Math.min(2, Math.floor(within / (TILE / 3))) };
}

/** The point to walk to for a building of this kind in the town nearest to x. */
export function nearestBuilding(x, kind) {
  let best = 0;
  for (let i = 1; i < TOWN_COLS.length; i++) {
    if (Math.abs(wrapDelta(x, townX(i, kind))) < Math.abs(wrapDelta(x, townX(best, kind)))) best = i;
  }
  return { town: best, x: townX(best, kind), y: TOWN_ROW * TILE + TILE / 2 };
}

function townX(town, kind) {
  return TOWN_COLS[town] * TILE + (kind + 0.5) * (TILE / 3);
}
