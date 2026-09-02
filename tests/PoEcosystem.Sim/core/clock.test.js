import { describe, expect, it } from 'vitest';
import { createClock } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/clock.js';
import { DAY_SECONDS, MAX_STEPS_PER_TICK, TICK_SECONDS, YEAR_SECONDS } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';

describe('clock', () => {
  it('converts wall time into whole fixed steps and never exceeds the step cap', () => {
    const c = createClock();
    expect(c.advance(TICK_SECONDS * 0.5)).toBe(0);
    expect(c.advance(TICK_SECONDS * 0.5)).toBe(1);
    expect(c.advance(TICK_SECONDS * 2.5)).toBe(2);
    expect(c.advance(10)).toBe(MAX_STEPS_PER_TICK);
    // The backlog is dropped, not carried: a hidden tab must not burst on return.
    expect(c.advance(0)).toBe(0);
  });

  it('applies the speed multiplier and pauses at 0', () => {
    const c = createClock();
    c.setSpeed(0);
    expect(c.advance(1)).toBe(0);
    c.setSpeed(4);
    expect(c.advance(TICK_SECONDS)).toBe(4);
    c.setSpeed(2);
    expect(c.advance(TICK_SECONDS)).toBe(2);
    expect(() => c.setSpeed(3)).toThrow();
  });

  it('counts ticks into sim seconds, years, days and the light cycle', () => {
    const c = createClock();
    const stepsPerYear = Math.round(YEAR_SECONDS / TICK_SECONDS);
    for (let i = 0; i < stepsPerYear * 2 + 10; i++) c.step();
    expect(c.tick).toBe(stepsPerYear * 2 + 10);
    expect(c.simSeconds).toBeCloseTo((stepsPerYear * 2 + 10) * TICK_SECONDS, 6);
    expect(c.year()).toBe(2);
    expect(c.dayFraction()).toBeGreaterThanOrEqual(0);
    expect(c.dayFraction()).toBeLessThan(1);
    expect(c.dayFraction()).toBeCloseTo(((stepsPerYear * 2 + 10) * TICK_SECONDS % DAY_SECONDS) / DAY_SECONDS, 6);
    expect(c.day()).toBeGreaterThanOrEqual(1);
  });

  it('round-trips its state', () => {
    const c = createClock();
    c.setSpeed(2);
    for (let i = 0; i < 123; i++) c.step();
    c.advance(TICK_SECONDS * 0.3);
    const s = c.getState();
    const d = createClock();
    d.setState(s);
    expect(d.tick).toBe(123);
    expect(d.speed).toBe(2);
    expect(d.advance(TICK_SECONDS * 0.7)).toBe(c.advance(TICK_SECONDS * 0.7));
  });
});
