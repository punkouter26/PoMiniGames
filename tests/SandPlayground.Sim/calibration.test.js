import { describe, expect, it } from 'vitest';
import {
  SAND_PLAYGROUND_CALIBRATION,
  capillaryCohesion,
  consumePhysicsSteps,
  effectiveStress,
  shieldsMobility,
} from '../../src/PoMiniGames.Client/wwwroot/js/sand-playground-calibration.js';

describe('SandPlayground calibration', () => {
  it('advances the same number of physics ticks at different display rates', () => {
    const run = (hz) => {
      let accumulator = 0;
      let steps = 0;
      for (let frame = 0; frame < hz; frame++) {
        const consumed = consumePhysicsSteps(accumulator, 1000 / hz);
        accumulator = consumed.accumulator;
        steps += consumed.steps;
      }
      return steps;
    };

    expect(run(30)).toBe(SAND_PLAYGROUND_CALIBRATION.physicsHz);
    expect(run(60)).toBe(SAND_PLAYGROUND_CALIBRATION.physicsHz);
    expect(run(120)).toBe(SAND_PLAYGROUND_CALIBRATION.physicsHz);
    expect(consumePhysicsSteps(0.8, 500).steps).toBeLessThanOrEqual(
      SAND_PLAYGROUND_CALIBRATION.maxCatchUpSteps,
    );
    expect(consumePhysicsSteps(0.8, 0, true)).toEqual({ steps: 1, accumulator: 0 });
  });

  it('matches the expected wet-sand and effective-stress curves', () => {
    expect(capillaryCohesion(0.2)).toBeGreaterThan(capillaryCohesion(0.02));
    expect(capillaryCohesion(0.2)).toBeGreaterThan(capillaryCohesion(0.9));
    expect(capillaryCohesion(-1)).toBe(0);
    expect(effectiveStress(10, 0, 20)).toBe(10);
    expect(effectiveStress(10, 1, 20)).toBe(0);
  });

  it('mobilises fine loose grains before coarse or packed grains', () => {
    const fine = shieldsMobility(0.2, 1, 0, 0.7);
    const coarse = shieldsMobility(0.2, 1, 0, 1.4);
    const packed = shieldsMobility(0.2, 1, 0.5, 0.7);
    expect(fine).toBeGreaterThan(coarse);
    expect(fine).toBeGreaterThan(packed);
  });
});
