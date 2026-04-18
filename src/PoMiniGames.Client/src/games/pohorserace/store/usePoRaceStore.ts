/**
 * usePoRaceStore.ts — Zustand store for top-level race FSM (PoRaceState).
 * Manages phase, elapsedSeconds, countdownValue, winnerLaneId.
 *
 * Timer note: internal `setInterval` handles map to NodeJS.Timeout | null.
 * All intervals are cleared before new ones are started (no leaks).
 *
 * M3 fix: finishRace() guards with `if (get().phase === 'Finished') return;`
 * to prevent double-fire from concurrent lane-check and ball-score triggers.
 */

import { create } from 'zustand';
import type { PoRacePhase, PoSummaryStats } from '../types/po-types';
import { PoSeedService } from '../services/PoSeedService';

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface PoRaceStore {
  // State
  phase: PoRacePhase;
  elapsedSeconds: number;
  countdownValue: number | null;
  winnerLaneId: number | null;
  summaryStats: PoSummaryStats | null;

  // Actions
  startCountdown: () => void;
  tickCountdown: () => void;
  startRace: () => void;
  tickElapsed: () => void;
  finishRace: (laneId: number, stats?: PoSummaryStats) => void;
  resetRace: () => void;

  // Internal timer refs (not serialisable; kept in store for cleanup)
  _countdownTimer: ReturnType<typeof setInterval> | null;
  _elapsedTimer: ReturnType<typeof setInterval> | null;
}

// ---------------------------------------------------------------------------
// Initial state derived from seed service
// ---------------------------------------------------------------------------

const SEED = PoSeedService.seedRaceState();

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePoRaceStore = create<PoRaceStore>()((set, get) => ({
  // ── initial state ──────────────────────────────────────────────────────
  phase: SEED.phase,
  elapsedSeconds: SEED.elapsedSeconds,
  countdownValue: SEED.countdownValue,
  winnerLaneId: SEED.winnerLaneId,
  summaryStats: null,
  _countdownTimer: null,
  _elapsedTimer: null,

  // ── actions ────────────────────────────────────────────────────────────

  startCountdown() {
    // Clear any lingering timer before starting
    const existing = get()._countdownTimer;
    if (existing !== null) clearInterval(existing);

    const timer = setInterval(() => get().tickCountdown(), 1_000);
    set({ phase: 'Countdown', countdownValue: 3, _countdownTimer: timer });
  },

  tickCountdown() {
    const { countdownValue, _countdownTimer } = get();
    if (countdownValue === null) return;

    if (countdownValue <= 1) {
      if (_countdownTimer !== null) clearInterval(_countdownTimer);
      set({ countdownValue: null, _countdownTimer: null });
      get().startRace();
    } else {
      set({ countdownValue: countdownValue - 1 });
    }
  },

  startRace() {
    const existing = get()._elapsedTimer;
    if (existing !== null) clearInterval(existing);

    const timer = setInterval(() => get().tickElapsed(), 1_000);
    set({ phase: 'Racing', elapsedSeconds: 0, _elapsedTimer: timer });
  },

  tickElapsed() {
    if (get().phase !== 'Racing') return;
    set(s => ({ elapsedSeconds: s.elapsedSeconds + 1 }));
  },

  finishRace(laneId, stats) {
    // M3 fix: idempotency guard — prevents double-fire from concurrent triggers
    if (get().phase === 'Finished') return;

    const elapsed = get()._elapsedTimer;
    if (elapsed !== null) clearInterval(elapsed);

    set({
      phase: 'Finished',
      winnerLaneId: laneId,
      _elapsedTimer: null,
      summaryStats: stats ?? null,
    });
  },

  resetRace() {
    const { _countdownTimer, _elapsedTimer } = get();
    if (_countdownTimer !== null) clearInterval(_countdownTimer);
    if (_elapsedTimer !== null) clearInterval(_elapsedTimer);

    const fresh = PoSeedService.seedRaceState();
    set({
      phase: fresh.phase,
      elapsedSeconds: fresh.elapsedSeconds,
      countdownValue: fresh.countdownValue,
      winnerLaneId: fresh.winnerLaneId,
      summaryStats: null,
      _countdownTimer: null,
      _elapsedTimer: null,
    });
  },
}));
