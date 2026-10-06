import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../src/PoMiniGames.Client/wwwroot/js/pomule/world.js', import.meta.url), 'utf8');
const w = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('an avatar leaving column 24 re-enters at column 1, and the other way round', () => {
  assert.equal(w.wrapX(w.WORLD_W + 5), 5);
  assert.equal(w.wrapX(-5), w.WORLD_W - 5);
  assert.equal(w.wrapX(100), 100);
  assert.equal(w.tileAt(w.WORLD_W + 5, 10).col, 0);
  assert.equal(w.tileAt(-1, 10).col, 23);
});

test('distance goes the short way round the seam, for every pair of columns', () => {
  assert.equal(w.wrapDelta(w.WORLD_W - 10, 10), 20);
  assert.equal(w.wrapDelta(10, w.WORLD_W - 10), -20);
  for (let a = 0; a < w.COLS; a++) {
    for (let b = 0; b < w.COLS; b++) {
      const steps = Math.abs(w.wrapDelta(a * w.TILE, b * w.TILE)) / w.TILE;
      const d = Math.abs(a - b);
      assert.equal(steps, Math.min(d, w.COLS - d), `columns ${a} and ${b}`);
    }
  }
});

test('tiles and their centres agree', () => {
  for (const index of [0, 23, 24, 100, 191]) {
    const c = w.tileCenter(index);
    assert.equal(w.tileAt(c.x, c.y).index, index);
  }
  assert.equal(w.tileAt(10, -50).row, 0, 'clamped at the north pole');
  assert.equal(w.tileAt(10, 9999).row, w.ROWS - 1, 'and the south');
});

test('inside the store, each stall is its own action and the middle of the floor is none', () => {
  assert.deepEqual(w.TOP_STALLS.map((cx) => w.stallAt(cx, 40)), [1, 2, 3, 4], 'outfit for Food, Energy, Smithore, Crystite');
  assert.deepEqual(w.BOTTOM_STALLS.map((cx) => w.stallAt(cx, w.WORLD_H - 40)), [w.TOWN_ASSAY, w.TOWN_PUB, w.TOWN_BUY_MULE]);
  assert.equal(w.stallAt(w.WORLD_W / 2, w.WORLD_H / 2), -1, 'where the player walks in');
  assert.equal(w.stallAt(w.TOP_STALLS[0] + w.STALL_HALF + 30, 40), -1, 'between two stalls');
});

test('the nearest town is found across the seam, and the door is on its plot', () => {
  // Just west of the seam, town 0 (column 2) is closer than town 3 (column 20).
  const pub = w.nearestBuilding(w.WORLD_W - 30, w.PUB);
  assert.equal(pub.town, 0);
  assert.deepEqual(w.tileAt(pub.x, pub.y), { col: w.TOWN_COLS[0], row: w.TOWN_ROW, index: w.TOWN_ROW * w.COLS + w.TOWN_COLS[0] });
  assert.equal(w.nearestBuilding(13 * w.TILE, w.ASSAY).town, 2);
});
