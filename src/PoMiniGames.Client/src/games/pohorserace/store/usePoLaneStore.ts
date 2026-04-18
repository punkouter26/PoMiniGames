/**
 * usePoLaneStore.ts — Zustand store for the 8 PoLane records.
 * Initialised from PoSeedService.seedLanes().
 * Uses subscribeWithSelector for HUD consumers (T039, PoHorseWall).
 *
 * T033 fix: addScore / setPosition are no-ops for non-player lanes.
 * T034 fix: spring animation lives in PoHorse.tsx; this store only holds
 *   positionInches as a plain number — not a spring target.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { PoLane } from '../types/po-types';
import { PoSeedService } from '../services/PoSeedService';
import { poCalcRanks } from '../utils/PoLeaderboard';
import { usePoGameModeStore } from './usePoGameModeStore';

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface PoLaneStore {
  lanes: PoLane[];

  // Actions
  addScore: (laneId: number, points: number) => void;
  setPosition: (laneId: number, inches: number) => void;
  setGoldGlow: (laneId: number, active: boolean) => void;
  resetAllLanes: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Points-to-inches conversion factor (each point moves horse N inches). */
const INCHES_PER_POINT = 0.6; // Calibrated so 1 point = ~1% of 60" track

function updateLane(
  lanes: PoLane[],
  laneId: number,
  update: Partial<PoLane>
): PoLane[] {
  return lanes.map(l => (l.id === laneId ? { ...l, ...update } : l));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePoLaneStore = create<PoLaneStore>()(
  subscribeWithSelector((set, get) => ({
    lanes: PoSeedService.seedLanes(),

    addScore(laneId, points) {
      const lane = get().lanes.find(l => l.id === laneId);
      if (!lane) return;

      const gameMode = usePoGameModeStore.getState().gameMode;
      if (gameMode !== 'demo' && !lane.isPlayerControlled) return;

      const newScore = lane.score + points;
      const newPositionInches = Math.min(
        lane.positionInches + points * INCHES_PER_POINT,
        60
      );
      const updated = updateLane(get().lanes, laneId, {
        score: newScore,
        positionInches: newPositionInches,
      });
      const ranks = poCalcRanks(updated);
      set({
        lanes: updated.map(l => ({ ...l, rank: ranks.get(l.id) ?? l.rank })),
      });

      // Trigger gold glow + race finish if 60" reached
      if (newPositionInches >= 60) {
        get().setGoldGlow(laneId, true);
      }
    },

    setPosition(laneId, inches) {
      const lane = get().lanes.find(l => l.id === laneId);
      if (!lane) return;

      const gameMode = usePoGameModeStore.getState().gameMode;
      if (gameMode !== 'demo' && !lane.isPlayerControlled) return;

      const clamped = Math.max(0, Math.min(60, inches));
      set({ lanes: updateLane(get().lanes, laneId, { positionInches: clamped }) });
    },

    setGoldGlow(laneId, active) {
      set({ lanes: updateLane(get().lanes, laneId, { goldGlowActive: active }) });

      // Trigger race finish when player reaches 60"
      if (active) {
        // Lazy-import to avoid circular dependency at module level
        import('../store/usePoRaceStore').then(({ usePoRaceStore }) => {
          usePoRaceStore.getState().finishRace(laneId);
        });
      }
    },

    resetAllLanes() {
      // C1 fix: pure data reset — NO hooks called here.
      // The visual slide-back animation is produced by PoHorse.tsx via react-spring
      // interpolating from current rendered position to 0 (see T034 implementation note).
      set({ lanes: PoSeedService.seedLanes() });
    },
  }))
);
