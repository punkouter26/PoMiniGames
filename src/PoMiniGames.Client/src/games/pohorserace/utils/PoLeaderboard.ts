/**
 * PoLeaderboard.ts — Rank calculation for the 8-lane leaderboard.
 *
 * Tiered ranking: lanes with the same positionInches share the same rank.
 * A gap is left in the rank sequence for tied positions
 * (standard competition ranking / "1224" ranking).
 *
 * Example:
 *   Lane positions: [60, 60, 40, 20, 20, 12, 5, 0]
 *   Ranks:          [ 1,  1,  3,  4,  4,  6, 7, 8]
 */

import type { PoLane } from '../types/po-types';

/**
 * Calculate leaderboard ranks for all lanes.
 * @param lanes — snapshot of PoLane records (any order)
 * @returns Map of lane id → rank (1-indexed; ties share the same rank)
 */
export function poCalcRanks(lanes: PoLane[]): Map<number, number> {
  // Sort descending by positionInches (highest = best rank 1)
  const sorted = [...lanes].sort((a, b) => b.positionInches - a.positionInches);

  const ranks = new Map<number, number>();
  let currentRank = 1;

  for (let i = 0; i < sorted.length; i++) {
    const lane = sorted[i]!;
    if (i > 0 && sorted[i]!.positionInches === sorted[i - 1]!.positionInches) {
      // Tied — inherit same rank as previous entry
      const prevLaneId = sorted[i - 1]!.id;
      ranks.set(lane.id, ranks.get(prevLaneId)!);
    } else {
      ranks.set(lane.id, currentRank);
    }
    currentRank++;
  }

  return ranks;
}
