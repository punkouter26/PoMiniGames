import { describe, expect, it } from 'vitest';
import { PICK, pickCreature } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/render/picking.js';
import { FRAME } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/frame.js';
import { SPECIES_ID } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/species.js';

/** Build a frame view holding creatures at the given positions. */
function frame(list) {
  const view = new Float32Array(list.length * FRAME.CREATURE_STRIDE);
  const handles = new Int32Array(list.length);
  list.forEach((c, k) => {
    const o = k * FRAME.CREATURE_STRIDE;
    // Default y puts the body centre (y + 0.6·scale) at the eye height, so these cases test
    // horizontal aim only.
    view[o] = c.x; view[o + 1] = c.y ?? 1.1; view[o + 2] = c.z;
    view[o + 4] = c.scale ?? 1; view[o + 5] = c.species ?? SPECIES_ID.RABBIT; view[o + 7] = c.stage ?? 1;
    handles[k] = c.handle ?? (k + 1) * 7;
  });
  return { view, handles, count: list.length };
}
const eye = { x: 0, y: 1.7, z: 0 };
const forward = { x: 0, y: 0, z: 1 };

describe('crosshair picking', () => {
  it('hits what the crosshair is on and ignores what is behind or too far', () => {
    const f = frame([
      { x: 0, z: 10, handle: 11 },
      { x: 0, z: -10, handle: 22 },                       // behind
      { x: 0, z: PICK.maxDistance + 5, handle: 33 },      // beyond range
    ]);
    const hit = pickCreature(eye, forward, f.view, f.handles, f.count);
    expect(hit).not.toBe(null);
    expect(hit.handle).toBe(11);
    expect(hit.distance).toBeGreaterThan(9);
    expect(hit.distance).toBeLessThan(11);
    expect(pickCreature(eye, { x: 0, y: 0, z: -1 }, f.view, f.handles, f.count).handle).toBe(22);
    expect(pickCreature(eye, forward, f.view, f.handles, 0)).toBe(null);
  });

  it('prefers the nearest of two creatures in line', () => {
    const f = frame([{ x: 0, z: 30, handle: 1 }, { x: 0, z: 8, handle: 2 }]);
    expect(pickCreature(eye, forward, f.view, f.handles, f.count).handle).toBe(2);
  });

  it('forgives a small aiming error that grows with distance, but not a large one', () => {
    // A rabbit 30 m away: 1 m off-axis is inside the assist cone, 4 m is not.
    const near = frame([{ x: 1, z: 30, handle: 5 }]);
    expect(pickCreature(eye, forward, near.view, near.handles, 1)?.handle).toBe(5);
    const wide = frame([{ x: 4, z: 30, handle: 6 }]);
    expect(pickCreature(eye, forward, wide.view, wide.handles, 1)).toBe(null);
    // At 3 m the same 1 m error is outside the cone — close aim must stay precise.
    const close = frame([{ x: 1, z: 3, handle: 7 }]);
    expect(pickCreature(eye, forward, close.view, close.handles, 1)).toBe(null);
    // With assist off, only a dead-centre hit counts.
    expect(pickCreature(eye, forward, near.view, near.handles, 1, { assist: 0 })).toBe(null);
  });

  it('scales the target with the creature: a deer is easier to hit than a juvenile rabbit', () => {
    const deer = frame([{ x: 1.2, z: 12, species: SPECIES_ID.DEER, handle: 1 }]);
    const pup = frame([{ x: 1.2, z: 12, species: SPECIES_ID.RABBIT, stage: 0, handle: 2 }]);
    expect(pickCreature(eye, forward, deer.view, deer.handles, 1)?.handle).toBe(1);
    expect(pickCreature(eye, forward, pup.view, pup.handles, 1)).toBe(null);
  });
});
