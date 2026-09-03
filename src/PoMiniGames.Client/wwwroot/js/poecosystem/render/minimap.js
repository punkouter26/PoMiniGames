// minimap.js — a 2D canvas map: the island's biomes drawn once, then species dots, huts,
// fire and the player's arrow on top each frame. Cheap enough to redraw at render rate.
import { TILE, TILE_STATE } from '../sim/terrain/tiles.js';
import { FRAME } from '../sim/frame.js';

const BIOME = {
  [TILE.OCEAN]: '#0c4a6e', [TILE.BEACH]: '#d8c48f', [TILE.GRASS]: '#4e7f2f', [TILE.FOREST]: '#1f5c2a',
  [TILE.HILL]: '#6b7a4a', [TILE.MOUNTAIN]: '#7a736b', [TILE.LAKE]: '#0ea5e9', [TILE.VOLCANO]: '#44403c',
};
const SPECIES_DOT = ['#fbbf24', '#34d399', '#f87171', '#c7d2fe'];

export function createMinimap(canvas, terrain) {
  const size = terrain.size;
  const base = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const bctx = base.getContext('2d');
  const ctx = canvas.getContext('2d');

  function paintBase(tileState) {
    const img = bctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const state = tileState?.[i] ?? 0;
      let hex = BIOME[terrain.type[i]] ?? '#555555';
      if (state === TILE_STATE.FIRE) hex = '#f97316';
      else if (state === TILE_STATE.LAVA) hex = '#ef4444';
      else if (state === TILE_STATE.BURNT) hex = '#2a2724';
      else if (state === TILE_STATE.HUT) hex = '#e2e8f0';
      const r = parseInt(hex.slice(1, 3), 16); const g = parseInt(hex.slice(3, 5), 16); const b = parseInt(hex.slice(5, 7), 16);
      const o = i * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
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
