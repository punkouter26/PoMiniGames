// scheduler.js — when the next lightning strike, rockslide and eruption happen. Each kind
// keeps its own next tick drawn from its interval range (events stream), and no two
// natural events fire within EVENTS.minSpacingSeconds of each other.
import { EVENTS, TICK_SECONDS } from '../core/config.js';

export const EVENT_KIND = Object.freeze({ LIGHTNING: 'lightning', ROCKSLIDE: 'rockslide', ERUPTION: 'eruption' });
const KINDS = Object.freeze([EVENT_KIND.LIGHTNING, EVENT_KIND.ROCKSLIDE, EVENT_KIND.ERUPTION]);
const secs = (s) => Math.round(s / TICK_SECONDS);

export function createEventScheduler(rng, cfg = EVENTS) {
  const next = {};
  let lastNatural = -Infinity;
  const schedule = (kind, from) => {
    const [lo, hi] = cfg.intervalSeconds[kind];
    next[kind] = from + secs(rng.range(lo, hi));
  };
  for (const kind of KINDS) schedule(kind, 0);
  return {
    nextTick: (kind) => next[kind],
    /** The kind due at `tick` (at most one per call), or null. Reschedules what it returns. */
    poll(tick) {
      if (tick - lastNatural < secs(cfg.minSpacingSeconds)) return null;
      for (const kind of KINDS) {
        if (tick >= next[kind]) { lastNatural = tick; schedule(kind, tick); return kind; }
      }
      return null;
    },
    /** A debug trigger counts as a natural event for spacing purposes. */
    markFired(kind, tick) { lastNatural = tick; schedule(kind, tick); },
    getState() { return { next: { ...next }, lastNatural: Number.isFinite(lastNatural) ? lastNatural : null }; },
    setState(s) {
      for (const kind of KINDS) if (s.next && Number.isFinite(s.next[kind])) next[kind] = s.next[kind];
      lastNatural = s.lastNatural ?? -Infinity;
    },
  };
}
