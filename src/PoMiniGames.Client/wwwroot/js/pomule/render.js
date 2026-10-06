// PoMule drawing: the scrolling planet, the eight-lane trading floor and the panorama strip.
// Everything here only reads the game object index.js owns; nothing here changes the match.
import * as W from './world.js';

const TERRAIN = ['#3f7d3a', '#2f6fb3', '#8a6a4a', '#6b4fa3', '#ffb300'];
const TERRAIN_DARK = ['#356b31', '#285f9b', '#6f5439', '#553d85', '#c98c00'];
const GOOD_COLOR = ['#8bd17c', '#ffe066', '#c9c9d4', '#c9a6ff'];
const GOOD_LETTER = ['F', 'E', 'S', 'C'];
const DOOR_LABEL = ['OUTFIT', 'PUB', 'ASSAY'];
const INK = '#12141a';
const PAPER = '#e8eaf0';
const MUTED = '#9aa3b5';
export const STRIP_H = 30;

/** Every world-x at which something at `x` is on screen (more than one on very wide views). */
function screenXs(x, camX, viewW) {
  const sx = W.screenX(x, camX, viewW);
  const out = [];
  for (let k = -1; k <= 1; k++) {
    const p = sx + k * W.WORLD_W;
    if (p > -W.TILE && p < viewW + W.TILE) out.push(p);
  }
  return out;
}

function drawTile(ctx, g, col, row, x, y) {
  const i = row * W.COLS + col;
  const terrain = g.terrain[i];
  ctx.fillStyle = TERRAIN[terrain];
  ctx.fillRect(x, y, W.TILE, W.TILE);
  ctx.fillStyle = TERRAIN_DARK[terrain];

  if (terrain === W.RIVER) {
    for (let k = 0; k < 3; k++) ctx.fillRect(x + 8 + ((k * 17 + row * 7) % 30), y + 12 + k * 18, 18, 4);
  } else if (terrain === W.MOUNTAIN) {
    const peaks = g.peaks[i];
    for (let k = 0; k < peaks; k++) {
      const px = x + 10 + k * (44 / peaks), w = 40 / peaks + 8;
      ctx.beginPath();
      ctx.moveTo(px, y + 52);
      ctx.lineTo(px + w / 2, y + 16);
      ctx.lineTo(px + w, y + 52);
      ctx.fill();
    }
  } else if (terrain === W.CRATER) {
    ctx.beginPath();
    ctx.ellipse(x + 32, y + 34, 20, 12, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (terrain === W.TOWN) {
    for (let k = 0; k < 3; k++) {
      const dx = x + k * (W.TILE / 3);
      ctx.fillStyle = INK;
      ctx.fillRect(dx + 2, y + 6, W.TILE / 3 - 4, W.TILE - 12);
      ctx.fillStyle = TERRAIN[W.TOWN];
      ctx.fillRect(dx + 7, y + 34, 7, 24);
      ctx.save();
      ctx.translate(dx + 15, y + 30);
      ctx.rotate(-Math.PI / 2);
      ctx.font = 'bold 7px monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = PAPER;
      ctx.fillText(DOOR_LABEL[k], -2, 3);
      ctx.restore();
    }
    return;
  } else {
    for (let k = 0; k < 4; k++) ctx.fillRect(x + 6 + ((k * 23 + col * 11) % 50), y + 8 + ((k * 31 + row * 13) % 46), 4, 4);
  }

  const owner = g.owner[i];
  if (owner >= 0) {
    ctx.strokeStyle = g.colors[owner];
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 3, y + 3, W.TILE - 6, W.TILE - 6);
  }
  const installed = g.installed[i];
  if (installed >= 0) {
    ctx.fillStyle = INK;
    ctx.fillRect(x + 20, y + 20, 24, 24);
    ctx.fillStyle = GOOD_COLOR[installed];
    ctx.fillRect(x + 23, y + 23, 18, 18);
    ctx.fillStyle = INK;
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(GOOD_LETTER[installed], x + 32, y + 37);
  }
  const crystite = g.crystite[i];
  for (let k = 0; k < crystite; k++) {
    ctx.fillStyle = GOOD_COLOR[3];
    ctx.fillRect(x + 6 + k * 8, y + W.TILE - 12, 6, 6);
  }
}

/** A small pixel colonist in the seat's colour, with one feature per species. */
function drawColonist(ctx, x, y, color, species, facing, dashing) {
  ctx.fillStyle = INK;
  ctx.fillRect(x - 11, y - 15, 22, 30);
  ctx.fillStyle = color;
  ctx.fillRect(x - 9, y - 13, 18, 26);
  ctx.fillStyle = INK;
  switch (species) {
    case 0: ctx.fillRect(x - 7, y - 10, 6, 6); ctx.fillRect(x + 1, y - 10, 6, 6); break;            // wide eyes
    case 1: for (let k = 0; k < 3; k++) ctx.fillRect(x - 9, y - 6 + k * 7, 18, 2); break;           // segments
    case 2: ctx.fillRect(x - 13, y - 4, 4, 4); ctx.fillRect(x + 9, y - 4, 4, 4);                    // four arms
            ctx.fillRect(x - 13, y + 4, 4, 4); ctx.fillRect(x + 9, y + 4, 4, 4); break;
    case 3: ctx.beginPath(); ctx.moveTo(x, y - 11); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 9);     // crystal
            ctx.lineTo(x - 6, y); ctx.fill(); break;
    case 4: ctx.fillRect(x - 15, y - 8, 6, 12); ctx.fillRect(x + 9, y - 8, 6, 12); break;           // wings
    case 5: ctx.fillRect(x - 9, y - 13, 18, 6); ctx.fillRect(x - 9, y + 7, 18, 6); break;           // armour
    case 6: ctx.beginPath(); ctx.arc(x, y - 1, 6, 0, Math.PI * 2); ctx.fill(); break;               // orb
    default: ctx.fillRect(x - 6, y - 10, 12, 8); break;                                             // visor
  }
  ctx.fillRect(x + facing * 4 - 1, y - 7, 2, 2);
  if (dashing) {
    ctx.fillStyle = color;
    ctx.fillRect(x - facing * 18, y - 4, 6, 2);
    ctx.fillRect(x - facing * 22, y + 4, 8, 2);
  }
}

function drawMule(ctx, x, y, outfit) {
  ctx.fillStyle = INK;
  ctx.fillRect(x - 10, y - 8, 20, 14);
  ctx.fillRect(x - 8, y + 6, 4, 6);
  ctx.fillRect(x + 4, y + 6, 4, 6);
  ctx.fillStyle = outfit >= 0 ? GOOD_COLOR[outfit] : MUTED;
  ctx.fillRect(x - 8, y - 6, 16, 10);
}

/** The planet as seen by the camera, with whatever the current phase puts on it. */
export function drawWorld(ctx, g, view) {
  const viewW = view.w / view.zoom;
  ctx.save();
  ctx.scale(view.zoom, view.zoom);
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, viewW, W.WORLD_H);
  for (const c of W.visibleColumns(g.cam.x, viewW)) {
    for (let row = 0; row < W.ROWS; row++) drawTile(ctx, g, c.col, row, Math.round(c.x), row * W.TILE);
  }
  ctx.strokeStyle = 'rgba(11, 13, 18, 0.55)';
  ctx.lineWidth = 1;
  for (const c of W.visibleColumns(g.cam.x, viewW)) ctx.strokeRect(Math.round(c.x) + 0.5, 0.5, W.TILE, W.WORLD_H);
  for (let row = 1; row < W.ROWS; row++) ctx.strokeRect(0, row * W.TILE + 0.5, viewW, 0);

  const highlight = (index, color, width = 4) => {
    const c = W.tileCenter(index);
    for (const sx of screenXs(c.x, g.cam.x, viewW)) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.strokeRect(sx - W.TILE / 2 + 6, c.y - W.TILE / 2 + 6, W.TILE - 12, W.TILE - 12);
    }
  };

  if (g.phase === 0) {
    for (let seat = g.seats - 1; seat >= 0; seat--) {
      // The player's own cursor is drawn where it is now, not where the engine last heard it was.
      const mine = seat === 0 && g.human;
      const pick = mine ? g.cursor.row * W.COLS + g.cursor.col : g.seat(seat, 14);
      if (pick >= 0) highlight(pick, g.colors[seat], mine ? 6 : 3);
    }
  } else if (g.phase === 1 && g.snap[4] >= 0) {
    highlight(g.snap[4], Math.floor(g.time * 4) % 2 ? PAPER : TERRAIN[W.TOWN], 6);
  } else if (g.phase === 2) {
    for (const a of g.avatars) {
      if (a.out) continue;
      if (a.mule) for (const sx of screenXs(a.mule.x, g.cam.x, viewW)) drawMule(ctx, sx, a.mule.y, a.outfit);
    }
    for (const r of g.runaways) for (const sx of screenXs(r.x, g.cam.x, viewW)) drawMule(ctx, sx, r.y, -1);
    for (const a of g.avatars) {
      if (a.out) continue;
      for (const sx of screenXs(a.x, g.cam.x, viewW)) drawColonist(ctx, sx, a.y, g.colors[a.seat], a.species, a.facing, a.dashing);
    }
  }
  ctx.restore();
}

/** The whole globe in one strip: all 24 columns, the seam, who is where, and what the camera sees. */
export function drawPanorama(ctx, g, view) {
  const top = view.h - STRIP_H, cw = view.w / W.COLS, ch = STRIP_H / W.ROWS;
  ctx.fillStyle = INK;
  ctx.fillRect(0, top, view.w, STRIP_H);
  for (let i = 0; i < g.terrain.length; i++) {
    const col = i % W.COLS, row = Math.floor(i / W.COLS);
    ctx.fillStyle = g.owner[i] >= 0 ? g.colors[g.owner[i]] : TERRAIN_DARK[g.terrain[i]];
    ctx.fillRect(col * cw, top + row * ch, Math.ceil(cw) - 1, Math.ceil(ch));
  }
  if (g.phase === 2) {
    for (const a of g.avatars) {
      if (a.out) continue;
      ctx.fillStyle = INK;
      ctx.fillRect((a.x / W.WORLD_W) * view.w - 3, top + (a.y / W.WORLD_H) * STRIP_H - 3, 6, 6);
      ctx.fillStyle = g.colors[a.seat];
      ctx.fillRect((a.x / W.WORLD_W) * view.w - 2, top + (a.y / W.WORLD_H) * STRIP_H - 2, 4, 4);
    }
  }
  // The camera window, drawn twice when it straddles the seam.
  const span = Math.min(1, view.w / view.zoom / W.WORLD_W) * view.w;
  const left = (W.wrapX(g.cam.x) / W.WORLD_W) * view.w - span / 2;
  ctx.strokeStyle = PAPER;
  ctx.lineWidth = 2;
  for (const k of [-1, 0, 1]) ctx.strokeRect(left + k * view.w, top + 1, span, STRIP_H - 2);
}

/** The trading floor: eight lanes on one price axis with the Store between lanes 4 and 5. */
export function drawMarket(ctx, g, view) {
  const good = g.snap[3], floor = g.snap[8], ceiling = floor * 2;
  const h = view.h - STRIP_H, top = 46, bottom = h - 40;
  const lane = view.w / 9.9;
  const laneX = (seat) => lane * 0.8 + lane * (seat < 4 ? seat : seat + 1) + lane / 2;
  const priceY = (p) => bottom - ((p - floor) / Math.max(1, ceiling - floor)) * (bottom - top);

  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, view.w, h);
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'left';
  for (const [p, label] of [[ceiling, 'Store sells'], [floor, 'Store buys']]) {
    ctx.strokeStyle = MUTED;
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lane * 0.8, priceY(p));
    ctx.lineTo(view.w, priceY(p));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = PAPER;
    ctx.fillText(String(p), 6, priceY(p) + 4);
  }

  // The Store.
  const sx = lane * 0.8 + lane * 4;
  ctx.fillStyle = '#1c2029';
  ctx.fillRect(sx + 4, top - 10, lane - 8, bottom - top + 20);
  ctx.fillStyle = TERRAIN[W.TOWN];
  ctx.textAlign = 'center';
  ctx.fillText('STORE', sx + lane / 2, top + 12);
  ctx.fillStyle = MUTED;
  ctx.font = '11px monospace';
  ctx.fillText('sells here', sx + lane / 2, top + 28);
  ctx.fillText('buys here', sx + lane / 2, bottom - 4);
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = GOOD_COLOR[good];
  ctx.fillText(['FOOD', 'ENERGY', 'SMITHORE', 'CRYSTITE'][good] ?? '', sx + lane / 2, (top + bottom) / 2);

  for (let seat = 0; seat < g.seats; seat++) {
    const x = laneX(seat), role = g.seat(seat, 9), price = g.seat(seat, 10), units = g.seat(seat, 1 + good);
    ctx.fillStyle = seat % 2 ? '#161922' : '#12141a';
    ctx.fillRect(x - lane / 2 + 2, top - 10, lane - 4, bottom - top + 20);
    ctx.fillStyle = g.colors[seat];
    ctx.fillRect(x - lane / 2 + 2, top - 10, lane - 4, 4);
    const y = role === 0 ? bottom + 18 : priceY(price);
    if (role === 1) {
      // A seller's crates stack below them.
      for (let k = 0; k < Math.min(units, 10); k++) {
        ctx.fillStyle = GOOD_COLOR[good];
        ctx.fillRect(x - 8, y + 18 + k * 9, 16, 7);
      }
    }
    ctx.globalAlpha = role === 0 ? 0.35 : 1;
    drawColonist(ctx, x, y, g.colors[seat], g.species[seat], role === 1 ? 1 : -1, false);
    ctx.globalAlpha = 1;
    if (role !== 0) {
      ctx.fillStyle = PAPER;
      ctx.font = 'bold 12px monospace';
      ctx.fillText(`${role === 1 ? 'ask' : 'bid'} ${price}`, x, y - 22);
    }
    ctx.fillStyle = MUTED;
    ctx.font = '11px monospace';
    ctx.fillText(`${units}`, x, h - 8);
  }

  // A line between the two sides of each trade, for a third of a second.
  for (const t of g.trades) {
    const from = t.seller < 0 ? sx + lane / 2 : laneX(t.seller);
    const to = t.buyer < 0 ? sx + lane / 2 : laneX(t.buyer);
    ctx.strokeStyle = GOOD_COLOR[good] ?? PAPER;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(from, priceY(t.price));
    ctx.lineTo(to, priceY(t.price));
    ctx.stroke();
  }
}
