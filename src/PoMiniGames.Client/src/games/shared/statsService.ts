import {
  type PlayerStats,
  type DifficultyStats,
  Difficulty,
  GameResult,
  getOrCreatePlayerId,
} from './types';
import { localStorageService } from './localStorageService';
import { apiService } from './apiService';

/**
 * Unified stats service. Reads/writes to localStorage immediately, then
 * attempts to sync with .NET API in the background. The app is fully
 * functional if the API is offline.
 */
export const statsService = {
  /** Record a game result and update stats. */
  async recordResult(
    game: string,
    playerName: string,
    difficulty: Difficulty,
    result: GameResult,
  ): Promise<PlayerStats> {
    // 1. Read current stats from localStorage
    const stats = localStorageService.getStats(game, playerName);

    // 2. Update the relevant difficulty bucket
    const bucket = statsService.getDifficultyBucket(stats, difficulty);
    bucket.totalGames++;
    switch (result) {
      case GameResult.Win:
        bucket.wins++;
        bucket.winStreak++;
        break;
      case GameResult.Loss:
        bucket.losses++;
        bucket.winStreak = 0;
        break;
      case GameResult.Draw:
        bucket.draws++;
        break;
      default:
        break;
    }
    bucket.winRate = bucket.totalGames > 0 ? bucket.wins / bucket.totalGames : 0;

    // 3. Recompute aggregates
    stats.totalWins = stats.easy.wins + stats.medium.wins + stats.hard.wins;
    stats.totalLosses = stats.easy.losses + stats.medium.losses + stats.hard.losses;
    stats.totalDraws = stats.easy.draws + stats.medium.draws + stats.hard.draws;
    stats.totalGames = stats.easy.totalGames + stats.medium.totalGames + stats.hard.totalGames;
    stats.winRate = stats.totalGames > 0 ? stats.totalWins / stats.totalGames : 0;
    stats.playerName = playerName;
    stats.playerId = stats.playerId || getOrCreatePlayerId(); // Track identity

    // 4. Save to localStorage immediately
    localStorageService.saveStats(game, playerName, stats);

    // 5. Fire-and-forget sync to API (app works fully offline)
    void apiService.savePlayerStats(game, playerName, stats);

    return stats;
  },

  /** Get stats for display. Reads from localStorage (instant). */
  getStats(game: string, playerName: string): PlayerStats {
    return localStorageService.getStats(game, playerName);
  },

  /** Get leaderboard. Tries API first, falls back to localStorage. */
  async getLeaderboard(game: string, limit = 10) {
    const apiResult = await apiService.getLeaderboard(game, limit);
    if (apiResult && apiResult.length > 0) {
      return apiResult.map((dto) => ({ name: dto.name, stats: dto.stats }));
    }
    // Fallback to localStorage
    return localStorageService.getLeaderboard(game, limit);
  },

  getDifficultyBucket(stats: PlayerStats, difficulty: Difficulty): DifficultyStats {
    switch (difficulty) {
      case Difficulty.Easy:
        return stats.easy;
      case Difficulty.Medium:
        return stats.medium;
      case Difficulty.Hard:
        return stats.hard;
    }
  },
};
