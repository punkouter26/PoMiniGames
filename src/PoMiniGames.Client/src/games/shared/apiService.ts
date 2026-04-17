import { getStoredAccessToken } from '../../context/authStorage';
import {
  type MultiplayerMatchSnapshot,
  type SupportedMultiplayerGame,
} from './multiplayerTypes';
import { type PlayerStats, type PlayerStatsDto } from './types';

/**
 * Optional API client for .NET backend leaderboard endpoints.
 * All methods are fire-and-forget safe — they never throw.
 * The app works fully without the API.
 */

const API_BASE = '/api';
const TIMEOUT_MS = 5000;

/**
 * Returns the ?user= query param from the current browser URL.
 * e.g. localhost:5173/?user=Alice  →  "Alice"
 */
export function getDevUserFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('user');
}

/**
 * Result returned by every safeFetch call.
 * `response` is set only when the server returned a 2xx status.
 * `status` is the HTTP status code, or 0 for network / timeout errors.
 */
export interface FetchResult {
  response: Response | null;
  status: number;
}

async function safeFetch(url: string, init?: RequestInit): Promise<FetchResult> {
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
    return res.ok
      ? { response: res, status: res.status }
      : { response: null, status: res.status };
  } catch {
    return { response: null, status: 0 };
  }
}

async function safeJson<T>(result: FetchResult): Promise<T | null> {
  if (!result.response) return null;
  try {
    return (await result.response.json()) as T;
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

/** Module-level cache so parallel callers share the same in-flight request. */
let _authConfigPromise: Promise<AuthClientConfiguration | null> | null = null;

export const apiService = {
  /** Check if the API is reachable. */
  async isAvailable(): Promise<boolean> {
    const { response } = await safeFetch(`${API_BASE}/health/ping`);
    return response !== null;
  },

  /** Get player stats from API. */
  async getPlayerStats(game: string, playerName: string): Promise<PlayerStatsDto | null> {
    const res = await safeFetch(`${API_BASE}/${game}/players/${encodeURIComponent(playerName)}/stats`);
    return safeJson<PlayerStatsDto>(res);
  },

  /** Save player stats to API. Returns ok=true on success; status=0 means network error, 401=unauthenticated. */
  async savePlayerStats(game: string, playerName: string, stats: PlayerStats): Promise<{ ok: boolean; status: number }> {
    const { response, status } = await safeFetch(`${API_BASE}/${game}/players/${encodeURIComponent(playerName)}/stats`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stats),
    });
    return { ok: response !== null, status };
  },

  /** Get leaderboard from API. Optionally filter by difficulty: 'easy' | 'medium' | 'hard' | 'all'. */
  async getLeaderboard(game: string, limit = 10, difficulty?: string): Promise<PlayerStatsDto[] | null> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (difficulty && difficulty !== 'all') params.set('difficulty', difficulty);
    const res = await safeFetch(`${API_BASE}/${game}/statistics/leaderboard?${params.toString()}`);
    return safeJson<PlayerStatsDto[]>(res);
  },

  async getAuthConfiguration(): Promise<AuthClientConfiguration | null> {
    // Share one in-flight request across all concurrent callers (e.g. AuthContext + GamePageShell).
    if (!_authConfigPromise) {
      _authConfigPromise = safeFetch(`${API_BASE}/auth/config`).then(safeJson<AuthClientConfiguration>);
    }
    return _authConfigPromise;
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

  /**
   * Developer Bypass — keeps the simple name-based sign-in experience,
   * but now reuses the shared dev-login endpoint under the hood.
   */
  async devBypass(userName?: string): Promise<AuthenticatedUserProfile | null> {
    const name = userName ?? getDevUserFromUrl() ?? 'Dev Admin';
    const slug = name.trim().toLowerCase().replace(/\s+/g, '-');
    return this.devLogin({
      userId: `dev-${slug}`,
      displayName: name,
      email: `${slug}@local.dev`,
    });
  },

  async devLogout(): Promise<boolean> {
    const { response } = await safeFetch(`${API_BASE}/auth/dev-logout`, {
      method: 'POST',
    });
    return response !== null;
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
