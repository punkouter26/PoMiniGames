import { describe, expect, it } from 'vitest';
import { createWorld } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/world.js';
import { SPECIES } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/species.js';

// SPEC §13 criterion 5. Five seeds × 15 sim-minutes; only runs with LONG=1 because it
// takes tens of seconds. Prints the per-species min/max so CP-C tuning has numbers.
const LONG = !!process.env.LONG;

describe.skipIf(!LONG)('population dynamics (LONG=1)', () => {
  it('shows boom-bust and no early extinction on at least 4 of 5 seeds', () => {
    const MINUTES = 15;
    let good = 0;
    const report = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const w = createWorld({ seed });
      let earlyExtinction = false;
      const min = [Infinity, Infinity, Infinity, Infinity]; const max = [0, 0, 0, 0];
      for (let t = 0; t < 20 * 60 * MINUTES; t++) {
        w.step();
        if (t % 20 === 0) {
          const c = w.stats().counts;
          for (let s = 0; s < 4; s++) { min[s] = Math.min(min[s], c[s]); max[s] = Math.max(max[s], c[s]); }
          if (t < 20 * 60 * 5 && c.some(v => v === 0)) earlyExtinction = true;
        }
      }
      const boomBust = max.some((mx, s) => min[s] > 0 && mx >= 1.5 * min[s]);
      const ok = boomBust && !earlyExtinction;
      if (ok) good++;
      report.push(`seed ${seed}: ${ok ? 'OK ' : 'BAD'} ${SPECIES.map((sp, s) => `${sp.name} ${min[s]}–${max[s]}`).join(', ')} final ${w.stats().counts.join('/')}`);
    }
    console.log(report.join('\n'));
    expect(good).toBeGreaterThanOrEqual(4);
  });
});
