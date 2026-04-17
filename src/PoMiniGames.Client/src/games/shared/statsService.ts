import {
  type PlayerStats,
  type DifficultyStats,
  Difficulty,
  GameResult,
  getOrCreatePlayerId,
  computeEloRating,
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

    // Compute ELO client-side (mirrors server-side EloCalculator).
    stats.easy.eloRating   = computeEloRating(stats.easy,   800);
    stats.medium.eloRating = computeEloRating(stats.medium, 1200);
    stats.hard.eloRating   = computeEloRating(stats.hard,   1600);

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

    // 5. Fire-and-forget sync to API; enqueue locally if it fails so a retry
    //    can be attempted when the user is next authenticated.
    apiService.savePlayerStats(game, playerName, stats).then(result => {
      if (!result.ok) {
        localStorageService.enqueuePendingSync(game, playerName, stats);
      }
    });

    return stats;
  },

  /** Flush pending stats syncs. Safe to call at any time; silently skips if nothing queued. */
  async flushPendingSync(): Promise<void> {
    const pending = localStorageService.getPendingSync();
    if (pending.length === 0) return;

    const remaining: typeof pending = [];
    for (const entry of pending) {
      const result = await apiService.savePlayerStats(entry.game, entry.playerName, entry.stats);
      if (!result.ok) {
        remaining.push(entry);
      }
    }
    localStorageService.setPendingSync(remaining);
  },

  /** Get stats for display. Reads from localStorage (instant). */
  getStats(game: string, playerName: string): PlayerStats {
    return localStorageService.getStats(game, playerName);
  },

  /** Get leaderboard. Tries API first, falls back to localStorage. */
  async getLeaderboard(game: string, limit = 10, difficulty?: string) {
    const apiResult = await apiService.getLeaderboard(game, limit, difficulty);
    if (apiResult && apiResult.length > 0) {
      return apiResult.map((dto) => ({ name: dto.name, stats: dto.stats }));
    }
    // Fallback to localStorage
    return localStorageService.getLeaderboard(game, limit, difficulty);
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
