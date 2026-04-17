import { type PlayerStats, emptyPlayerStats, computeEloRating } from './types';

const STORAGE_PREFIX = 'pomini_stats_';
const PENDING_SYNC_KEY = 'pomini_pending_sync';

interface PendingSyncEntry {
  game: string;
  playerName: string;
  stats: PlayerStats;
  queuedAt: string;
}

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

  /** Get leaderboard for a specific game from localStorage. Optionally filter by difficulty. */
  getLeaderboard(game: string, limit = 10, difficulty?: string): { name: string; stats: PlayerStats }[] {
    const allForGame = localStorageService
      .getAllStats()
      .filter((s) => s.game === game);

    const diff = difficulty?.toLowerCase();

    if (diff === 'easy') {
      return allForGame
        .filter((s) => s.stats.easy.totalGames > 0)
        .sort((a, b) => {
          const ra = a.stats.easy.eloRating ?? computeEloRating(a.stats.easy, 800);
          const rb = b.stats.easy.eloRating ?? computeEloRating(b.stats.easy, 800);
          return rb - ra || b.stats.easy.totalGames - a.stats.easy.totalGames;
        })
        .slice(0, limit)
        .map(({ name, stats }) => ({ name, stats }));
    }
    if (diff === 'medium') {
      return allForGame
        .filter((s) => s.stats.medium.totalGames > 0)
        .sort((a, b) => {
          const ra = a.stats.medium.eloRating ?? computeEloRating(a.stats.medium, 1200);
          const rb = b.stats.medium.eloRating ?? computeEloRating(b.stats.medium, 1200);
          return rb - ra || b.stats.medium.totalGames - a.stats.medium.totalGames;
        })
        .slice(0, limit)
        .map(({ name, stats }) => ({ name, stats }));
    }
    if (diff === 'hard') {
      return allForGame
        .filter((s) => s.stats.hard.totalGames > 0)
        .sort((a, b) => {
          const ra = a.stats.hard.eloRating ?? computeEloRating(a.stats.hard, 1600);
          const rb = b.stats.hard.eloRating ?? computeEloRating(b.stats.hard, 1600);
          return rb - ra || b.stats.hard.totalGames - a.stats.hard.totalGames;
        })
        .slice(0, limit)
        .map(({ name, stats }) => ({ name, stats }));
    }

    // Default: aggregate win-rate ranking.
    return allForGame
      .sort((a, b) => {
        const wr = (b.stats.winRate || 0) - (a.stats.winRate || 0);
        return wr !== 0 ? wr : (b.stats.totalGames || 0) - (a.stats.totalGames || 0);
      })
      .slice(0, limit)
      .map(({ name, stats }) => ({ name, stats }));
  },

  /** Add or replace a pending-sync entry for the given game+player. */
  enqueuePendingSync(game: string, playerName: string, stats: PlayerStats): void {
    const existing = localStorageService.getPendingSync();
    const updated = existing.filter(e => !(e.game === game && e.playerName === playerName));
    updated.push({ game, playerName, stats, queuedAt: new Date().toISOString() });
    localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(updated));
  },

  /** Return all pending-sync entries. */
  getPendingSync(): PendingSyncEntry[] {
    const raw = localStorage.getItem(PENDING_SYNC_KEY);
    if (!raw) return [];
    try { return JSON.parse(raw) as PendingSyncEntry[]; } catch { return []; }
  },

  /** Persist the remaining (unsynced) entries, or clear the key if empty. */
  setPendingSync(entries: PendingSyncEntry[]): void {
    if (entries.length === 0) {
      localStorage.removeItem(PENDING_SYNC_KEY);
    } else {
      localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(entries));
    }
  },
};
