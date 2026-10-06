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

test('the camera crosses the seam with no jump or gap', () => {
  const viewW = 800;
  // Something 30px east of the camera sits 30px right of centre wherever the camera is.
  for (const camX of [400, w.WORLD_W - 20, w.WORLD_W - 1, 0, 15]) {
    assert.equal(w.screenX(camX + 30, camX, viewW), viewW / 2 + 30);
    assert.equal(w.screenX(w.wrapX(camX + 30), camX, viewW), viewW / 2 + 30);
  }
  // Columns drawn at the seam are contiguous, cover the view, and wrap 23 → 0.
  const cols = w.visibleColumns(w.WORLD_W - 10, viewW);
  for (let i = 1; i < cols.length; i++) {
    assert.equal(cols[i].x - cols[i - 1].x, w.TILE);
    assert.equal(cols[i].col, (cols[i - 1].col + 1) % w.COLS);
  }
  assert.ok(cols[0].x <= 0 && cols.at(-1).x + w.TILE >= viewW);
  assert.ok(cols.some((c) => c.col === 23) && cols.some((c) => c.col === 0));
});

test('tiles and their centres agree', () => {
  for (const index of [0, 23, 24, 100, 191]) {
    const c = w.tileCenter(index);
    assert.equal(w.tileAt(c.x, c.y).index, index);
  }
  assert.equal(w.tileAt(10, -50).row, 0, 'clamped at the north pole');
  assert.equal(w.tileAt(10, 9999).row, w.ROWS - 1, 'and the south');
});

test('a town tile is Outfitter, Pub, Assay Office left to right; other tiles are not buildings', () => {
  const left = w.TOWN_COLS[1] * w.TILE, y = w.TOWN_ROW * w.TILE + 10;
  assert.deepEqual(w.buildingAt(left + 5, y), { town: 1, kind: w.OUTFITTER });
  assert.deepEqual(w.buildingAt(left + 32, y), { town: 1, kind: w.PUB });
  assert.deepEqual(w.buildingAt(left + 60, y), { town: 1, kind: w.ASSAY });
  assert.equal(w.buildingAt(left + 5, y + w.TILE), null);
  assert.equal(w.buildingAt(left - 5, y), null);
});

test('the nearest town is found across the seam, and its door is that building', () => {
  // Just west of the seam, town 0 (column 2) is closer than town 3 (column 20).
  const pub = w.nearestBuilding(w.WORLD_W - 30, w.PUB);
  assert.equal(pub.town, 0);
  assert.deepEqual(w.buildingAt(pub.x, pub.y), { town: 0, kind: w.PUB });
  assert.equal(w.nearestBuilding(13 * w.TILE, w.ASSAY).town, 2);
});
