// minimap.js — a 2D canvas map: the island's biomes drawn once, then species dots, huts,
// fire and the player's arrow on top each frame. Cheap enough to redraw at render rate.
import { TILE, TILE_STATE } from '../sim/terrain/tiles.js';
import { FRAME } from '../sim/frame.js';

const BIOME = {
  [TILE.OCEAN]: '#0c4a6e', [TILE.BEACH]: '#d8c48f', [TILE.GRASS]: '#4e7f2f', [TILE.FOREST]: '#1f5c2a',
  [TILE.HILL]: '#6b7a4a', [TILE.MOUNTAIN]: '#7a736b', [TILE.LAKE]: '#0ea5e9', [TILE.VOLCANO]: '#44403c',
};
const SPECIES_DOT = ['#fbbf24', '#34d399', '#f87171', '#c7d2fe'];

const STATE_HEX = {
  [TILE_STATE.FIRE]: '#f97316', [TILE_STATE.LAVA]: '#ef4444',
  [TILE_STATE.BURNT]: '#2a2724', [TILE_STATE.HUT]: '#e2e8f0',
};
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

export function createMinimap(canvas, terrain) {
  const size = terrain.size;
  const base = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const bctx = base.getContext('2d');
  const ctx = canvas.getContext('2d');

  // Palettes and the image buffer are built once: parsing 120 000 hex substrings per
  // repaint cost ~4 ms of the main thread every second.
  const biomePalette = new Uint8Array(8 * 3);
  for (let t = 0; t < 8; t++) biomePalette.set(rgb(BIOME[t] ?? '#555555'), t * 3);
  const statePalette = new Uint8Array(8 * 3).fill(0);
  const stateHas = new Uint8Array(8);
  for (const [state, hex] of Object.entries(STATE_HEX)) { statePalette.set(rgb(hex), state * 3); stateHas[state] = 1; }
  const img = bctx.createImageData(size, size);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;   // opaque, once

  function paintBase(tileState) {
    const data = img.data;
    for (let i = 0; i < size * size; i++) {
      const state = tileState?.[i] ?? 0;
      const src = stateHas[state] ? statePalette : biomePalette;
      const s = (stateHas[state] ? state : terrain.type[i]) * 3;
      const o = i * 4;
      data[o] = src[s]; data[o + 1] = src[s + 1]; data[o + 2] = src[s + 2];
    }
    bctx.putImageData(img, 0, 0);
  }
  paintBase(null);

  return {
    setTiles: (msg) => paintBase(msg.tileState),
    draw(view, count, player) {
      const w = canvas.width; const h = canvas.height;
      const s = w / size;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(base, 0, 0, w, h);
      for (let k = 0; k < count; k++) {
        const o = k * FRAME.CREATURE_STRIDE;
        ctx.fillStyle = SPECIES_DOT[view[o + 5] | 0] ?? '#ffffff';
        ctx.fillRect(view[o] * s - 1, view[o + 2] * s - 1, 2.5, 2.5);
      }
      // Player arrow, pointing along the view direction.
      const px = player.x * s; const pz = player.z * s;
      ctx.save();
      ctx.translate(px, pz);
      ctx.rotate(-player.yaw);
      ctx.fillStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.moveTo(0, -6); ctx.lineTo(4, 5); ctx.lineTo(0, 2.5); ctx.lineTo(-4, 5);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    },
    dispose() {},
  };
}
