import { type PlayerStats, type PlayerStatsDto } from './types';

/**
 * Optional API client for .NET backend leaderboard endpoints.
 * All methods are fire-and-forget safe — they never throw.
 * The app works fully without the API.
 */

const API_BASE = '/api';
const TIMEOUT_MS = 5000;

async function safeFetch(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

export const apiService = {
  /** Check if the API is reachable. */
  async isAvailable(): Promise<boolean> {
    const res = await safeFetch(`${API_BASE}/health/ping`);
    return res !== null;
  },

  /** Get player stats from API. */
  async getPlayerStats(game: string, playerName: string): Promise<PlayerStatsDto | null> {
    const res = await safeFetch(`${API_BASE}/${game}/players/${encodeURIComponent(playerName)}/stats`);
    if (!res) return null;
    try {
      return (await res.json()) as PlayerStatsDto;
    } catch {
      return null;
    }
  },

  /** Save player stats to API (fire-and-forget). */
  async savePlayerStats(game: string, playerName: string, stats: PlayerStats): Promise<boolean> {
    const res = await safeFetch(`${API_BASE}/${game}/players/${encodeURIComponent(playerName)}/stats`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stats),
    });
    return res !== null;
  },

  /** Get leaderboard from API. */
  async getLeaderboard(game: string, limit = 10): Promise<PlayerStatsDto[] | null> {
    const res = await safeFetch(`${API_BASE}/${game}/statistics/leaderboard?limit=${limit}`);
    if (!res) return null;
    try {
      return (await res.json()) as PlayerStatsDto[];
    } catch {
      return null;
    }
  },
};
