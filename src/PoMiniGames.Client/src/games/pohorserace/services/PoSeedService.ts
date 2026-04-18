/**
 * PoSeedService.ts — GoF Strategy pattern: offline-first seed data.
 * Annotation: // GoF Strategy — offline-first seed replaces absent HTTP response.
 * Returns deterministic initial state; each method logs via PoLogger.
 * Constitution Principle III: app stays fully functional with no API.
 */

import type { PoRaceState, PoLane, PoBall, PoGameMode } from '../types/po-types';
import { PoLogger } from '../utils/PoLogger';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const LANE_COLORS: PoLane['color'][] = [
  'PoRed', 'PoBlue', 'PoYellow', 'PoGreen',
  'PoOrange', 'PoPurple', 'PoPink', 'PoWhite',
];

// ---------------------------------------------------------------------------
// PoSeedService singleton
// ---------------------------------------------------------------------------

class PoSeedServiceImpl {
  // GoF Strategy — offline-first seed replaces absent HTTP response.

  seedRaceState(): PoRaceState {
    const state: PoRaceState = {
      phase: 'Idle',
      elapsedSeconds: 0,
      countdownValue: null,
      winnerLaneId: null,
    };
    PoLogger.log({
      timestamp: new Date().toISOString(),
      level: 'debug',
      service: 'PoSeedService',
      action: 'seedRaceState',
      status: 'ok',
    });
    return state;
  }

  seedLanes(): PoLane[] {
    const lanes: PoLane[] = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      color: LANE_COLORS[i]!,
      positionInches: 0,
      score: 0,
      rank: i + 1,
      isPlayerControlled: i === 0, // only lane 1 is player-controlled (FR-014)
      goldGlowActive: false,
    }));
    PoLogger.log({
      timestamp: new Date().toISOString(),
      level: 'debug',
      service: 'PoSeedService',
      action: 'seedLanes',
      status: 'ok',
      detail: { count: lanes.length },
    });
    return lanes;
  }

  seedBalls(mode: PoGameMode = 'normal'): PoBall[] {
    const balls: PoBall[] = mode === 'demo'
      ? Array.from({ length: 8 }, (_, laneIndex) =>
        Array.from({ length: 3 }, (_, slotIndex) => ({
          id: laneIndex * 3 + slotIndex,
          laneId: laneIndex + 1,
          phase: 'InTrough' as const,
          positionX: 0,
          positionY: 0,
          velocityX: 0,
          velocityY: 0,
          releaseSpeedMph: null,
          returnTimerSeconds: null,
        }))
      ).flat()
      : Array.from({ length: 3 }, (_, i) => ({
        id: i,
        laneId: 1,
        phase: 'InTrough' as const,
        positionX: 0,
        positionY: 0,
        velocityX: 0,
        velocityY: 0,
        releaseSpeedMph: null,
        returnTimerSeconds: null,
      }));
    PoLogger.log({
      timestamp: new Date().toISOString(),
      level: 'debug',
      service: 'PoSeedService',
      action: 'seedBalls',
      status: 'ok',
      detail: { count: balls.length },
    });
    return balls;
  }
}

/** Exported singleton. */
export const PoSeedService = new PoSeedServiceImpl();
