// clock.js — fixed-step accumulator plus the world calendar.
import { DAYS_PER_YEAR, DAY_SECONDS, MAX_STEPS_PER_TICK, SPEEDS, TICK_SECONDS, YEAR_SECONDS } from './config.js';

export function createClock({ tickSeconds = TICK_SECONDS, maxStepsPerTick = MAX_STEPS_PER_TICK } = {}) {
  let accumulator = 0;
  const clock = {
    tick: 0,
    simSeconds: 0,
    speed: 1,
    tickSeconds,
    setSpeed(s) {
      if (!SPEEDS.includes(s)) throw new RangeError(`speed must be one of ${SPEEDS.join(', ')}`);
      clock.speed = s;
    },
    /**
     * Feed wall-clock seconds; returns how many fixed steps to run now. The
     * backlog beyond the cap is discarded so a tab that was hidden for a minute
     * resumes smoothly instead of bursting.
     */
    advance(wallDt) {
      if (clock.speed === 0) { accumulator = 0; return 0; }
      accumulator += Math.max(0, wallDt) * clock.speed;
      let steps = Math.floor(accumulator / tickSeconds + 1e-9);
      if (steps > maxStepsPerTick) { steps = maxStepsPerTick; accumulator = 0; }
      else accumulator -= steps * tickSeconds;
      return steps;
    },
    step() { clock.tick += 1; clock.simSeconds = clock.tick * tickSeconds; },
    year() { return Math.floor(clock.simSeconds / YEAR_SECONDS); },
    /** 1-based day within the current year, for the HUD clock. */
    day() { return Math.floor((clock.simSeconds % YEAR_SECONDS) / YEAR_SECONDS * DAYS_PER_YEAR) + 1; },
    /** Position in the cosmetic light cycle, [0,1). */
    dayFraction() { return (clock.simSeconds % DAY_SECONDS) / DAY_SECONDS; },
    getState() { return { tick: clock.tick, speed: clock.speed, accumulator }; },
    setState(s) {
      clock.tick = s.tick | 0;
      clock.simSeconds = clock.tick * tickSeconds;
      clock.speed = SPEEDS.includes(s.speed) ? s.speed : 1;
      accumulator = Number.isFinite(s.accumulator) ? s.accumulator : 0;
    },
  };
  return clock;
}
