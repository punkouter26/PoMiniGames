const API_BASE_URL = import.meta.env.VITE_GAME_URL_PORACERAGDOLL || 'http://localhost:5002';

/**
 * Timeout duration for API requests in milliseconds.
 * If the API doesn't respond within this window, the call is aborted
 * and the client falls back to offline mode gracefully.
 */
const API_TIMEOUT_MS = 5000;

export interface Racer {
    id: number;
    name: string;
    species: string;
    type: string;
    color: string;
    mass: number;
    odds: number;
}

export interface GameState {
    balance: number;
    round: number;
    maxRounds: number;
    state: 'BETTING' | 'RACING' | 'FINISHED';
    racers: Racer[];
    selectedRacerId: number | null;
    betAmount: number;
    winnerId: number | null;
}

export interface RaceResult {
    winnerId: number;
    winnerName: string;
    playerWon: boolean;
    payout: number;
    newBalance: number;
}

export interface SessionResponse {
    sessionId: string;
    state: GameState;
}

/**
 * Wraps a fetch call with a timeout to avoid hanging requests.
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });
        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}

export const api = {
    async checkHealth(): Promise<boolean> {
        try {
            const res = await fetchWithTimeout(`${API_BASE_URL}/health`);
            return res.ok;
        } catch {
            return false;
        }
    },

    async createSession(): Promise<SessionResponse> {
        const res = await fetchWithTimeout(`${API_BASE_URL}/api/game/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
        return res.json();
    },

    async placeBet(sessionId: string, racerId: number): Promise<GameState> {
        const res = await fetchWithTimeout(`${API_BASE_URL}/api/game/session/${sessionId}/bet`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ racerId }),
        });
        if (!res.ok) throw new Error(`Failed to place bet: ${res.status}`);
        return res.json();
    },

    async finishRace(sessionId: string, winnerId: number): Promise<{ state: GameState; result: RaceResult }> {
        const res = await fetchWithTimeout(`${API_BASE_URL}/api/game/session/${sessionId}/finish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ winnerId }),
        });
        if (!res.ok) throw new Error(`Failed to finish race: ${res.status}`);
        return res.json();
    },

    async nextRound(sessionId: string): Promise<GameState> {
        const res = await fetchWithTimeout(`${API_BASE_URL}/api/game/session/${sessionId}/next`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) throw new Error(`Failed to advance round: ${res.status}`);
        return res.json();
    },
};
