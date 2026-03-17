import { getStoredAccessToken } from '../../context/authStorage';
import {
  type ConnectFiveMultiplayerState,
  type MultiplayerMatchSnapshot,
  type SupportedMultiplayerGame,
  type TicTacToeMultiplayerState,
} from './multiplayerTypes';
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
    const headers = new Headers(init?.headers);
    const token = getStoredAccessToken();
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const res = await fetch(url, { ...init, headers, signal: controller.signal, credentials: 'include' });
    clearTimeout(timer);
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

async function safeJson<T>(response: Response | null): Promise<T | null> {
  if (!response) return null;
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export interface AuthClientConfiguration {
  enabled: boolean;
  clientId: string;
  authority: string;
  scope: string;
  redirectPath: string;
  microsoftEnabled: boolean;
  devLoginEnabled: boolean;
}

export interface AuthenticatedUserProfile {
  userId: string;
  displayName: string;
  email: string | null;
}
  export interface SnakeHighScore {
    initials: string;
    score: number;
    date: string;
    gameDuration: number;
    snakeLength: number;
    foodEaten: number;
  }


export interface DevLoginRequest {
  userId?: string;
  displayName?: string;
  email?: string;
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
    return safeJson<PlayerStatsDto>(res);
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
    return safeJson<PlayerStatsDto[]>(res);
  },

  async getAuthConfiguration(): Promise<AuthClientConfiguration | null> {
    const res = await safeFetch(`${API_BASE}/auth/config`);
    return safeJson<AuthClientConfiguration>(res);
  },

  async getAuthenticatedUser(accessToken?: string): Promise<AuthenticatedUserProfile | null> {
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
    const res = await safeFetch(`${API_BASE}/auth/me`, { headers });
    return safeJson<AuthenticatedUserProfile>(res);
  },

  async devLogin(request?: DevLoginRequest): Promise<AuthenticatedUserProfile | null> {
    const res = await safeFetch(`${API_BASE}/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request ?? {}),
    });
    return safeJson<AuthenticatedUserProfile>(res);
  },

  async devLogout(): Promise<boolean> {
    const res = await safeFetch(`${API_BASE}/auth/dev-logout`, {
      method: 'POST',
    });
    return res !== null;
  },

  async getSupportedMultiplayerGames(): Promise<SupportedMultiplayerGame[] | null> {
    const res = await safeFetch(`${API_BASE}/multiplayer/games`);
    return safeJson<SupportedMultiplayerGame[]>(res);
  },

  async joinMultiplayerQueue(gameKey: string): Promise<MultiplayerMatchSnapshot | null> {
    const res = await safeFetch(`${API_BASE}/multiplayer/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameKey }),
    });
    return safeJson<MultiplayerMatchSnapshot>(res);
  },

  async getMultiplayerMatch(matchId: string): Promise<MultiplayerMatchSnapshot | null> {
    const res = await safeFetch(`${API_BASE}/multiplayer/matches/${encodeURIComponent(matchId)}`);
    return safeJson<MultiplayerMatchSnapshot>(res);
  },

  async leaveMultiplayerMatch(matchId: string): Promise<MultiplayerMatchSnapshot | null> {
    const res = await safeFetch(`${API_BASE}/multiplayer/matches/${encodeURIComponent(matchId)}`, {
      method: 'DELETE',
    });
    return safeJson<MultiplayerMatchSnapshot>(res);
  },

  async submitTurn(matchId: string, action: Record<string, number>): Promise<MultiplayerMatchSnapshot | null> {
    const res = await safeFetch(`${API_BASE}/multiplayer/matches/${encodeURIComponent(matchId)}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    return safeJson<MultiplayerMatchSnapshot>(res);
  },
  
    async getSnakeHighScores(limit = 10): Promise<SnakeHighScore[] | null> {
      const res = await safeFetch(`${API_BASE}/snake/highscores?count=${limit}`);
      return safeJson<SnakeHighScore[]>(res);
    },

    async submitSnakeHighScore(entry: Omit<SnakeHighScore, 'date'>): Promise<SnakeHighScore | null> {
      const full: SnakeHighScore = { ...entry, date: new Date().toISOString() };
      const res = await safeFetch(`${API_BASE}/snake/highscores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(full),
      });
      return safeJson<SnakeHighScore>(res);
    },
};

export type { MultiplayerMatchSnapshot, SupportedMultiplayerGame, TicTacToeMultiplayerState, ConnectFiveMultiplayerState };
