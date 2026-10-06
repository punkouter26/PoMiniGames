// PoMule drawing: the scrolling planet, the eight-lane trading floor and the panorama strip.
// Everything here only reads the game object index.js owns; nothing here changes the match.
//
// The look follows the 1983 Atari 800 game: pale grey ground, plots fenced in their owner's
// colour with the M.U.L.E.'s glyph inside, a dotted orange river, small grey mountains and a
// black store block, all in fat pixels. The planet is drawn into a quarter-resolution canvas
// (a 64-unit plot is 16 pixels) and blown up with smoothing off, so every shape here is
// built from 4-unit cells.
import * as W from './world.js';

const PX = 4;                    // one fat pixel, in world units
const GROUND = '#dcdce0';
const SPECK = '#c4c4c8';
const RIVER = '#f0a020';         // the Atari river is a band of orange dots
const ROCK = '#a4a4a8';
const TOWN = '#000000';
const WINDOW = '#f4f4f4';
const CRYSTITE = '#8040c0';
const ORANGE = '#c86000';        // the Atari's message colour
const INK = '#000000';
const PAPER = '#f4f4f4';
const TEXT = '#585858';
export const STRIP_H = 30;

/** Every screen x at which something at world `x` shows (more than one on very wide views). */
function screenXs(x, camX, viewW) {
  const sx = W.screenX(x, camX, viewW);
  const out = [];
  for (let k = -1; k <= 1; k++) {
    const p = sx + k * W.WORLD_W;
    if (p > -W.TILE && p < viewW + W.TILE) out.push(p);
  }
  return out;
}

/** Fat-pixel rectangles: [cellX, cellY, width, height] inside a plot, one cell per Atari pixel. */
function cells(ctx, x, y, color, list) {
  ctx.fillStyle = color;
  for (const [cx, cy, cw = 1, ch = 1] of list) ctx.fillRect(x + cx * PX, y + cy * PX, cw * PX, ch * PX);
}

// What an installed M.U.L.E. is making, drawn in its owner's colour as on the Atari:
// a plant, a pair of arrows, a pick-and-pile, a gem.
const GOOD_GLYPH = [
  [[3, 0, 1, 7], [1, 1, 1, 2], [5, 1, 1, 2], [2, 3, 3, 1], [0, 0, 1, 1], [6, 0, 1, 1], [1, 8, 1, 1], [3, 8, 1, 1], [5, 8, 1, 1]],
  [[0, 1, 6, 1], [5, 0, 1, 3], [6, 1, 1, 1], [1, 5, 6, 1], [1, 4, 1, 3], [0, 5, 1, 1], [2, 8, 1, 1], [4, 8, 1, 1]],
  [[2, 0, 1, 7], [0, 1, 5, 1], [4, 2, 1, 3], [0, 3, 2, 1], [0, 5, 2, 1], [1, 8, 1, 1], [3, 8, 1, 1], [5, 8, 1, 1]],
  [[3, 0, 1, 1], [2, 1, 3, 1], [1, 2, 5, 1], [0, 3, 7, 1], [1, 4, 5, 1], [2, 5, 3, 1], [3, 6, 1, 1], [1, 8, 1, 1], [5, 8, 1, 1]],
];

function drawTile(ctx, g, col, row, x, y) {
  const i = row * W.COLS + col;
  const terrain = g.terrain[i];
  ctx.fillStyle = terrain === W.TOWN ? TOWN : GROUND;
  ctx.fillRect(x, y, W.TILE, W.TILE);

  if (terrain === W.RIVER) {
    // A stipple of dots down the middle of the plot.
    const dots = [];
    for (let r = 0; r < 16; r++) for (let c = 5; c < 11; c++) if ((r + c + (r >> 1)) % 2 === 0) dots.push([c + ((r >> 2) % 2), r]);
    cells(ctx, x, y, RIVER, dots);
  } else if (terrain === W.MOUNTAIN) {
    // One small grey bump per peak, scattered like the original's.
    const spots = [[2, 9], [9, 5], [6, 12]];
    for (let k = 0; k < g.peaks[i]; k++) {
      const [mx, my] = spots[k];
      cells(ctx, x, y, ROCK, [[mx + 2, my - 2, 1, 1], [mx + 1, my - 1, 3, 1], [mx, my, 5, 1]]);
    }
  } else if (terrain === W.CRATER) {
    cells(ctx, x, y, ROCK, [[5, 5, 6, 1], [4, 6, 1, 4], [11, 6, 1, 4], [5, 10, 6, 1]]);
    cells(ctx, x, y, SPECK, [[5, 6, 6, 4]]);
  } else if (terrain === W.TOWN) {
    // The store: a black block with lit windows and three doors (Outfitter, Pub, Assay Office).
    cells(ctx, x, y, WINDOW, [[1, 1, 3, 2], [6, 1, 4, 2], [12, 1, 3, 2], [1, 8, 3, 7], [6, 8, 4, 7], [12, 8, 3, 7]]);
    cells(ctx, x, y, TOWN, [[2, 10, 1, 5], [7, 10, 2, 5], [13, 10, 1, 5]]);
    return;
  } else {
    cells(ctx, x, y, SPECK, [[3 + (col * 5) % 9, 4], [11 - (row * 3) % 7, 10]]);
  }

  // A claimed plot is fenced in its owner's colour.
  const owner = g.owner[i];
  if (owner >= 0) {
    cells(ctx, x, y, g.colors[owner], [[0, 0, 16, 1], [0, 15, 16, 1], [0, 0, 1, 16], [15, 0, 1, 16]]);
  }
  const installed = g.installed[i];
  if (installed >= 0) {
    ctx.fillStyle = owner >= 0 ? g.colors[owner] : TEXT;
    for (const [cx, cy, cw, ch] of GOOD_GLYPH[installed]) ctx.fillRect(x + (5 + cx) * PX, y + (4 + cy) * PX, cw * PX, ch * PX);
  }
  for (let k = 0; k < g.crystite[i]; k++) cells(ctx, x, y, CRYSTITE, [[2 + k * 2, 2, 1, 1]]);
}

/** A blocky one-colour colonist, with one feature per species. Origin is its centre. */
function drawColonist(ctx, x, y, color, species, facing, dashing, scale = 1) {
  const u = PX * scale;
  const block = (c, list) => {
    ctx.fillStyle = c;
    for (const [cx, cy, cw = 1, ch = 1] of list) ctx.fillRect(x + cx * u, y + cy * u, cw * u, ch * u);
  };
  block(color, [[-1, -4, 2, 2], [-2, -2, 4, 3], [-2, 1, 1, 3], [1, 1, 1, 3]]);
  switch (species) {
    case 0: block(color, [[-2, -4, 1, 1], [1, -4, 1, 1]]); break;                       // wide eyes on stalks
    case 1: block(GROUND, [[-2, -1, 4, 1]]); break;                                      // segmented chassis
    case 2: block(color, [[-3, -2, 1, 1], [2, -2, 1, 1], [-3, 0, 1, 1], [2, 0, 1, 1]]); break; // four arms
    case 3: block(color, [[-1, -5, 1, 1], [0, -6, 1, 1]]); break;                        // crystal spire
    case 4: block(color, [[-4, -3, 2, 2], [2, -3, 2, 2]]); break;                        // wings
    case 5: block(color, [[-3, -2, 6, 1], [-3, 2, 1, 2], [2, 2, 1, 2]]); break;          // broad and armoured
    case 6: block(GROUND, [[-2, 1, 1, 3], [1, 1, 1, 3]]); block(color, [[-1, 2, 2, 1]]); break; // hovers, no legs
    default: block(GROUND, [[-1, -3, 2, 1]]); break;                                     // visor
  }
  if (dashing) block(color, [[-facing * 4 - (facing > 0 ? 1 : 0), -1, 2, 1], [-facing * 5 - (facing > 0 ? 1 : 0), 1, 2, 1]]);
}

function drawMule(ctx, x, y, color) {
  cells(ctx, x - 3 * PX, y - 2 * PX, color, [[0, 0, 5, 2], [0, 2, 1, 2], [4, 2, 1, 2], [5, -1, 1, 2], [6, -2, 1, 1]]);
}

/** The planet as seen by the camera, with whatever the current phase puts on it. */
export function drawWorld(ctx, g, view) {
  const viewW = Math.ceil(view.w / view.zoom / PX) * PX;
  // Quarter-resolution buffer, reused between frames.
  const lo = (g.lo ??= document.createElement('canvas'));
  if (lo.width !== viewW / PX || lo.height !== W.WORLD_H / PX) {
    lo.width = viewW / PX;
    lo.height = W.WORLD_H / PX;
  }
  const c = lo.getContext('2d');
  c.setTransform(1 / PX, 0, 0, 1 / PX, 0, 0);
  c.fillStyle = GROUND;
  c.fillRect(0, 0, viewW, W.WORLD_H);

  // Snap everything to whole fat pixels so plots do not shimmer as the camera scrolls.
  const snap = (v) => Math.round(v / PX) * PX;
  const camX = snap(g.cam.x);
  for (const col of W.visibleColumns(camX, viewW)) {
    for (let row = 0; row < W.ROWS; row++) drawTile(c, g, col.col, row, snap(col.x), row * W.TILE);
  }

  const highlight = (index, color) => {
    const t = W.tileCenter(index);
    for (const sx of screenXs(t.x, camX, viewW)) {
      cells(c, snap(sx - W.TILE / 2), t.y - W.TILE / 2, color, [[0, 0, 16, 2], [0, 14, 16, 2], [0, 0, 2, 16], [14, 0, 2, 16]]);
    }
  };

  const blink = Math.floor(g.time * 6) % 2 === 0;
  if (g.phase === 0 && g.snap[10] >= 0) {
    // The one land-grant highlighter everybody watches.
    highlight(g.snap[10], blink ? INK : ORANGE);
  } else if (g.phase === 1 && g.snap[4] >= 0) {
    highlight(g.snap[4], blink ? INK : ORANGE);
  } else if (g.phase === 2) {
    for (const a of g.avatars) {
      if (a.out || !a.mule) continue;
      for (const sx of screenXs(a.mule.x, camX, viewW)) drawMule(c, snap(sx), snap(a.mule.y), g.colors[a.seat]);
    }
    for (const r of g.runaways) for (const sx of screenXs(r.x, camX, viewW)) drawMule(c, snap(sx), snap(r.y), TEXT);
    for (const a of g.avatars) {
      if (a.out) continue;
      for (const sx of screenXs(a.x, camX, viewW)) drawColonist(c, snap(sx), snap(a.y), g.colors[a.seat], a.species, a.facing, a.dashing);
    }
  }

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(lo, 0, 0, lo.width, lo.height, 0, 0, viewW * view.zoom, W.WORLD_H * view.zoom);
}

/** The whole globe in one strip: all 24 columns, the seam, who is where, and what the camera sees. */
export function drawPanorama(ctx, g, view) {
  const shade = [GROUND, RIVER, ROCK, SPECK, TOWN];
  const top = view.h - STRIP_H, cw = view.w / W.COLS, ch = STRIP_H / W.ROWS;
  ctx.fillStyle = TEXT;
  ctx.fillRect(0, top, view.w, STRIP_H);
  for (let i = 0; i < g.terrain.length; i++) {
    const col = i % W.COLS, row = Math.floor(i / W.COLS);
    ctx.fillStyle = g.owner[i] >= 0 ? g.colors[g.owner[i]] : shade[g.terrain[i]];
    ctx.fillRect(Math.floor(col * cw), Math.floor(top + row * ch), Math.ceil(cw) - 1, Math.ceil(ch));
  }
  if (g.phase === 0 && g.snap[10] >= 0) {
    const i = g.snap[10];
    ctx.fillStyle = INK;
    ctx.fillRect(Math.floor((i % W.COLS) * cw), Math.floor(top + Math.floor(i / W.COLS) * ch), Math.ceil(cw), Math.ceil(ch));
  }
  if (g.phase === 2) {
    for (const a of g.avatars) {
      if (a.out) continue;
      const x = Math.floor((a.x / W.WORLD_W) * view.w), y = Math.floor(top + (a.y / W.WORLD_H) * STRIP_H);
      ctx.fillStyle = INK;
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.fillStyle = g.colors[a.seat];
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
  }
  // The camera window, drawn twice when it straddles the seam.
  const span = Math.min(1, view.w / view.zoom / W.WORLD_W) * view.w;
  const left = (W.wrapX(g.cam.x) / W.WORLD_W) * view.w - span / 2;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  for (const k of [-1, 0, 1]) ctx.strokeRect(left + k * view.w, top + 1, span, STRIP_H - 2);
}

/** The trading floor: eight lanes on one price axis with the Store between lanes 4 and 5. */
export function drawMarket(ctx, g, view) {
  const good = g.snap[3], floor = g.snap[8], ceiling = floor * 2;
  const h = view.h - STRIP_H, top = 52, bottom = h - 44;
  const lane = view.w / 9.9;
  const laneX = (seat) => lane * 0.8 + lane * (seat < 4 ? seat : seat + 1) + lane / 2;
  const priceY = (p) => Math.round(bottom - ((p - floor) / Math.max(1, ceiling - floor)) * (bottom - top));
  const font = (px) => `900 ${px}px ui-monospace, Consolas, monospace`;

  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, view.w, h);

  // The Store: the same black block as on the map, standing between lanes 4 and 5.
  const sx = lane * 0.8 + lane * 4;
  ctx.fillStyle = TOWN;
  ctx.fillRect(sx + 6, top - 12, lane - 12, bottom - top + 24);
  ctx.textAlign = 'center';
  ctx.font = font(14);
  ctx.fillStyle = WINDOW;
  ctx.fillText('STORE', sx + lane / 2, top + 14);
  ctx.fillText(['FOOD', 'ENERGY', 'SMITHORE', 'CRYSTITE'][good] ?? '', sx + lane / 2, (top + bottom) / 2);
  ctx.font = font(11);
  ctx.fillText('SELLS', sx + lane / 2, top + 30);
  ctx.fillText('BUYS', sx + lane / 2, bottom - 6);

  // The Store's two prices, as dotted orange lines across every lane.
  for (const p of [ceiling, floor]) {
    ctx.fillStyle = RIVER;
    for (let x = lane * 0.8; x < view.w; x += 12) ctx.fillRect(x, priceY(p) - 2, 6, 4);
    ctx.textAlign = 'left';
    ctx.font = font(14);
    ctx.fillStyle = ORANGE;
    ctx.fillText(String(p), 6, priceY(p) + 5);
  }

  ctx.textAlign = 'center';
  for (let seat = 0; seat < g.seats; seat++) {
    const x = Math.round(laneX(seat)), role = g.seat(seat, 9), price = g.seat(seat, 10), units = g.seat(seat, 1 + good);
    ctx.fillStyle = g.colors[seat];
    ctx.fillRect(x - lane / 2 + 6, top - 12, lane - 12, 6);
    const y = role === 0 ? bottom + 22 : priceY(price);
    if (role === 1) {
      // A seller's crates stack below them.
      for (let k = 0; k < Math.min(units, 10); k++) ctx.fillRect(x - 8, y + 20 + k * 10, 16, 8);
    }
    ctx.globalAlpha = role === 0 ? 0.35 : 1;
    drawColonist(ctx, x, y, g.colors[seat], g.species[seat], role === 1 ? 1 : -1, false, 0.75);
    ctx.globalAlpha = 1;
    ctx.fillStyle = TEXT;
    ctx.font = font(12);
    if (role !== 0) ctx.fillText(`${role === 1 ? 'ASK' : 'BID'} ${price}`, x, y - 18);
    ctx.fillText(`${units}`, x, h - 8);
  }

  // A bar between the two sides of each trade, for a third of a second.
  for (const t of g.trades) {
    const from = t.seller < 0 ? sx + lane / 2 : laneX(t.seller);
    const to = t.buyer < 0 ? sx + lane / 2 : laneX(t.buyer);
    ctx.fillStyle = INK;
    ctx.fillRect(Math.min(from, to), priceY(t.price) - 3, Math.abs(to - from), 6);
  }
}
