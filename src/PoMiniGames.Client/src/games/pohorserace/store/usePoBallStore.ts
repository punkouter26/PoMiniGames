/**
 * usePoBallStore.ts — Zustand store for the 3-ball economy.
 *
 * H2 fix: sessionReleaseSpeedsMph accumulator persists all launch speeds across
 * the session; it is the sole source of truth for Summary Card avgRollSpeedMph.
 * Individual PoBall.releaseSpeedMph records the LAST speed for that ball only.
 *
 * T050 / M5 fix: resetAll() clears the accumulator; setPhase(id, 'InTrough')
 * does NOT reset releaseSpeedMph because the speed was already appended on launch.
 */

import { create } from 'zustand';
import type { PoBall, PoBallPhase } from '../types/po-types';
import { PoSeedService } from '../services/PoSeedService';
import { usePoGameModeStore } from './usePoGameModeStore';

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface PoBallStore {
  balls: PoBall[];
  /**
   * H2 fix: accumulator of all release speeds this session (never truncated until reset).
   * Feeds PoSummaryStats.avgRollSpeedMph via mean calculation at race finish.
   */
  sessionReleaseSpeedsMph: number[];

  // Actions
  setPhase: (ballId: number, phase: PoBallPhase) => void;
  /**
   * Record release speed for a ball AND append to the session accumulator.
   * Must NOT be called more than once per flight (spec: set once at swipe release).
   */
  setReleaseSpeed: (ballId: number, mph: number) => void;
  tickReturn: (ballId: number) => void;
  resetAll: () => void;

  // Selectors
  canLaunch: (laneId?: number) => boolean;
  getActiveHandle: (laneId?: number) => import('../components/PoBall').PoBallHandle | null;
  launchBallFromLane: (laneId: number, impulse: { ix: number; iy: number; iz: number }, mph: number) => number | null;

  // Internal timer refs
  _returnTimers: Record<number, ReturnType<typeof setInterval>>;
  // Imperative handle registry for active physics bodies (avoids React ref drilling)
  _handles: Record<number, import('../components/PoBall').PoBallHandle>;
  registerHandle: (ballId: number, handle: import('../components/PoBall').PoBallHandle | null) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateBall(balls: PoBall[], ballId: number, update: Partial<PoBall>): PoBall[] {
  return balls.map(b => (b.id === ballId ? { ...b, ...update } : b));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePoBallStore = create<PoBallStore>()((set, get) => ({
  balls: PoSeedService.seedBalls(usePoGameModeStore.getState().gameMode),
  sessionReleaseSpeedsMph: [],
  _returnTimers: {},
  _handles: {},

  registerHandle(ballId, handle) {
    set(s => {
      const updated = { ...s._handles };
      if (handle) {
        updated[ballId] = handle;
      } else {
        delete updated[ballId];
      }
      return { _handles: updated };
    });
  },

  getActiveHandle(laneId) {
    const ball = get().balls.find(
      b => b.phase === 'InTrough' && (laneId === undefined || b.laneId === laneId)
    );
    if (!ball) return null;
    return get()._handles[ball.id] ?? null;
  },

  launchBallFromLane(laneId, impulse, mph) {
    const store = get();
    const troughBalls = store.balls.filter(b => b.phase === 'InTrough' && b.laneId === laneId);
    if (troughBalls.length === 0) return null;

    const activeBall = troughBalls[Math.floor(Math.random() * troughBalls.length)]!;
    const handle = store._handles[activeBall.id];
    if (!handle) return null;

    store.setReleaseSpeed(activeBall.id, Math.max(0, mph));
    store.setPhase(activeBall.id, 'InFlight');
    handle.applyImpulse(impulse.ix, impulse.iy, impulse.iz);
    return activeBall.id;
  },

  setPhase(ballId, phase) {
    if (phase === 'Scoring') {
      // Start 4-second return timer (enough time to roll down the lower return ramp)
      const existing = get()._returnTimers[ballId];
      if (existing !== undefined) clearInterval(existing);

      const timer = setInterval(() => get().tickReturn(ballId), 1_000);
      set(s => ({
        balls: updateBall(s.balls, ballId, {
          phase: 'Scoring',
          returnTimerSeconds: 4,
        }),
        _returnTimers: { ...s._returnTimers, [ballId]: timer },
      }));
      return;
    }

    if (phase === 'InTrough') {
      // Clear return timer; keep releaseSpeedMph (speed already in accumulator — M5/H2 fix)
      const existing = get()._returnTimers[ballId];
      if (existing !== undefined) {
        clearInterval(existing);
        const updated = { ...get()._returnTimers };
        delete updated[ballId];
        set(s => ({
          balls: updateBall(s.balls, ballId, {
            phase: 'InTrough',
            returnTimerSeconds: null,
            positionX: 0,
            positionY: 0,
          }),
          _returnTimers: updated,
        }));
      } else {
        set(s => ({
          balls: updateBall(s.balls, ballId, {
            phase: 'InTrough',
            returnTimerSeconds: null,
            positionX: 0,
            positionY: 0,
          }),
        }));
      }
      return;
    }

    // Generic phase setter (InFlight + Returning)
    // For InFlight: start a 5-second safety bail-out so balls that miss all holes
    // automatically return to the trough and can be reused.
    if (phase === 'InFlight') {
      // Clear any existing return timer for this ball first
      const existing = get()._returnTimers[ballId];
      if (existing !== undefined) clearInterval(existing);

      const safetyTimer = setTimeout(() => {
        const b = get().balls.find(bb => bb.id === ballId);
        // Only return if still InFlight (hasn't been scored in the meantime)
        if (b?.phase === 'InFlight') {
          get().setPhase(ballId, 'Returning');
          setTimeout(() => get().setPhase(ballId, 'InTrough'), 400);
        }
        // Clean up timer ref
        set(s => {
          const updated = { ...s._returnTimers };
          delete updated[ballId];
          return { _returnTimers: updated };
        });
      }, 5000);

      set(s => ({
        balls: updateBall(s.balls, ballId, { phase }),
        _returnTimers: { ...s._returnTimers, [ballId]: safetyTimer as unknown as ReturnType<typeof setInterval> },
      }));
      return;
    }

    set(s => ({ balls: updateBall(s.balls, ballId, { phase }) }));
  },

  setReleaseSpeed(ballId, mph) {
    set(s => ({
      balls: updateBall(s.balls, ballId, { releaseSpeedMph: mph }),
      // H2 fix: append to accumulator — never erase individual entries
      sessionReleaseSpeedsMph: [...s.sessionReleaseSpeedsMph, mph],
    }));
  },

  tickReturn(ballId) {
    const ball = get().balls.find(b => b.id === ballId);
    if (!ball || ball.phase !== 'Scoring') return;

    const next = (ball.returnTimerSeconds ?? 0) - 1;
    if (next <= 0) {
      get().setPhase(ballId, 'Returning');
      // Transition to InTrough after a brief Returning phase (chute animation hook)
      setTimeout(() => get().setPhase(ballId, 'InTrough'), 500);
    } else {
      set(s => ({
        balls: updateBall(s.balls, ballId, { returnTimerSeconds: next }),
      }));
    }
  },

  resetAll() {
    // Clear all return timers
    const timers = get()._returnTimers;
    Object.values(timers).forEach(t => clearInterval(t));
    set({
      balls: PoSeedService.seedBalls(usePoGameModeStore.getState().gameMode),
      sessionReleaseSpeedsMph: [], // H2 fix: clear accumulator on full reset
      _returnTimers: {},
      _handles: {}, // Reset handles (components should remount/reregister)
    });
  },

  canLaunch(laneId) {
    return get().balls.some(
      b => b.phase === 'InTrough' && (laneId === undefined || b.laneId === laneId)
    );
  },
}));
