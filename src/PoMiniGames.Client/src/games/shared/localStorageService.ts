import { type PlayerStats, emptyPlayerStats } from './types';

const STORAGE_PREFIX = 'pomini_stats_';

/** Pure localStorage-backed stats service. Always works offline. */
export const localStorageService = {
  /** Get stats for a player in a specific game. */
  getStats(game: string, playerName: string): PlayerStats {
    const key = `${STORAGE_PREFIX}${game}_${playerName}`;
    const raw = localStorage.getItem(key);
    if (!raw) return emptyPlayerStats(playerName);
    try {
      return JSON.parse(raw) as PlayerStats;
    } catch {
      return emptyPlayerStats(playerName);
    }
  },

  /** Save stats for a player in a specific game. */
  saveStats(game: string, playerName: string, stats: PlayerStats): void {
    const key = `${STORAGE_PREFIX}${game}_${playerName}`;
    stats.updatedAt = new Date().toISOString();
    localStorage.setItem(key, JSON.stringify(stats));
  },

  /** Get all stored player stats across all games. */
  getAllStats(): { game: string; name: string; stats: PlayerStats }[] {
    const results: { game: string; name: string; stats: PlayerStats }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      const rest = key.slice(STORAGE_PREFIX.length);
      const separatorIdx = rest.indexOf('_');
      if (separatorIdx < 0) continue;
      const game = rest.slice(0, separatorIdx);
      const name = rest.slice(separatorIdx + 1);
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        results.push({ game, name, stats: JSON.parse(raw) as PlayerStats });
      } catch {
        // skip corrupt entries
      }
    }
    return results;
  },

  /** Get leaderboard for a specific game from localStorage. */
  getLeaderboard(game: string, limit = 10): { name: string; stats: PlayerStats }[] {
    return localStorageService
      .getAllStats()
      .filter((s) => s.game === game)
      .sort((a, b) => {
        const wr = (b.stats.overallWinRate || 0) - (a.stats.overallWinRate || 0);
        return wr !== 0 ? wr : (b.stats.totalGames || 0) - (a.stats.totalGames || 0);
      })
      .slice(0, limit)
      .map(({ name, stats }) => ({ name, stats }));
  },
};
