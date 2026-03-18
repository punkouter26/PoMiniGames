import { create } from 'zustand';
import { api, type GameState, type Racer, type RaceResult } from '../lib/api';
import { INITIAL_BALANCE, INITIAL_BET, TOTAL_ROUNDS, RACER_SPECIES } from '../lib/config';

const SESSION_STORAGE_KEY = 'poraceragdoll-session';

/**
 * Ports OddsService.CalculateOdds from C# so offline mode produces meaningful
 * per-racer odds instead of a flat 1:1 for every participant.
 * Mirrors the fixed >= 20 slope branch (audit item #1).
 */
function calculateOdds(mass: number): number {
    const slopeAngle = 20.0;
    let score = 50.0;
    const massFactor = mass * 2;
    score += massFactor * (slopeAngle >= 20 ? 0.5 : 0.2);
    score += (Math.random() * 20) - 10;
    let probability = (score + 50) / 200;
    probability = Math.max(0.05, Math.min(0.95, probability));
    if (probability >= 0.5) {
        return -Math.round((probability / (1 - probability)) * 100);
    }
    return Math.round(((1 - probability) / probability) * 100);
}

const generateRacers = (): Racer[] => {
    const racers: Racer[] = [];
    for (let i = 0; i < 8; i++) {
        const species = RACER_SPECIES[Math.floor(Math.random() * RACER_SPECIES.length)]!;
        const massVariance = (Math.random() * 10) - 5;
        const finalMass = Math.max(10, species.mass + massVariance);
        const names = ['Dash', 'Blaze', 'Ryder', 'Skye', 'Nova', 'Ace', 'Milo', 'Zara'];
        const baseName = names[Math.floor(Math.random() * names.length)] ?? 'Runner';
        racers.push({
            id: i,
            name: `${baseName} the ${species.name}`,
            species: species.name,
            type: species.type,
            color: species.color,
            mass: Math.round(finalMass * 10) / 10,
            odds: calculateOdds(finalMass),
        });
    }
    return racers;
};

export interface RoundResult {
    round: number;
    winnerId: number;
    winnerName: string;
    playerWon: boolean;
    payout: number;
    selectedRacerName: string;
}

interface GameStore extends GameState {
    sessionId: string | null;
    lastResult: RaceResult | null;
    isOnline: boolean;
    isLoading: boolean;
    error: string | null;
    isHydrated: boolean;
    roundHistory: RoundResult[];
    lastPayout: number;
    /** True while waiting for the server to confirm the race winner. Shown as a
     * "Deciding winner..." overlay so the physics animation never shows an
     * incorrect winner before the server responds (audit item #7). */
    isResolvingResult: boolean;

    initSession: () => Promise<void>;
    selectRacer: (id: number) => void;
    placeBet: () => Promise<void>;
    finishRace: (winnerId: number) => Promise<void>;
    nextRound: () => Promise<void>;
    setOnlineMode: (online: boolean) => void;
    hydrate: () => void;
    /** Restores an existing server session from sessionStorage without creating a new one. */
    restoreSession: (sessionId: string) => Promise<void>;
}

export const useGameStore = create<GameStore>((set, get) => ({
    sessionId: null,
    balance: INITIAL_BALANCE,
    round: 1,
    maxRounds: TOTAL_ROUNDS,
    state: 'Betting',
    racers: [],
    selectedRacerId: null,
    betAmount: INITIAL_BET,
    winnerId: null,
    lastResult: null,
    isOnline: false,
    isLoading: false,
    error: null,
    isHydrated: false,
    roundHistory: [],
    lastPayout: 0,
    isResolvingResult: false,

    hydrate: () => {
        const { isHydrated } = get();
        if (!isHydrated) {
            set({ racers: generateRacers(), isHydrated: true });
            api.checkHealth().then(healthy => {
                if (healthy) {
                    // Try to restore a previous session from the same browser tab (#8).
                    const savedId = sessionStorage.getItem(SESSION_STORAGE_KEY);
                    if (savedId) {
                        get().restoreSession(savedId);
                    } else {
                        get().setOnlineMode(true);
                    }
                }
            }).catch(() => {
                // API not available, offline mode
            });
        }
    },

    restoreSession: async (sessionId: string) => {
        try {
            const state = await api.getSession(sessionId);
            set({ sessionId, ...state, isOnline: true });
        } catch {
            // Session expired server-side; discard and create fresh.
            sessionStorage.removeItem(SESSION_STORAGE_KEY);
            get().setOnlineMode(true);
        }
    },

    initSession: async () => {
        const { isOnline } = get();
        if (!isOnline) return;
        set({ isLoading: true, error: null });
        try {
            const { sessionId, state } = await api.createSession();
            sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
            set({ sessionId, ...state, isLoading: false });
        } catch {
            set({ error: 'Failed to connect to server. Running in offline mode.', isOnline: false, isLoading: false });
        }
    },

    selectRacer: (id: number) => {
        set({ selectedRacerId: id });
    },

    placeBet: async () => {
        const { isOnline, sessionId, selectedRacerId, balance, betAmount, state: gameState } = get();
        if (gameState !== 'Betting' || selectedRacerId === null) return;
        if (balance < betAmount) return;

        if (isOnline && sessionId) {
            set({ isLoading: true });
            try {
                const newState = await api.placeBet(sessionId, selectedRacerId);
                set({ ...newState, isLoading: false });
            } catch {
                set({ error: 'Failed to place bet', isLoading: false });
            }
        } else {
            set({ balance: balance - betAmount, state: 'Racing' });
        }
    },

    finishRace: async (winnerId: number) => {
        const { isOnline, sessionId, selectedRacerId, racers, betAmount, balance } = get();

        if (isOnline && sessionId) {
            // Show resolving overlay immediately so physics winner animation is not
            // mistaken for the authoritative result before the server responds (#7).
            set({ isLoading: true, isResolvingResult: true });
            try {
                const { state, result } = await api.finishRace(sessionId);
                set({ ...state, lastResult: result, isLoading: false, isResolvingResult: false });
            } catch {
                set({ error: 'Failed to finish race', isLoading: false, isResolvingResult: false });
            }
        } else {
            const winner = racers.find(r => r.id === winnerId);
            let newBalance = balance;
            const playerWon = selectedRacerId === winnerId;

            if (playerWon && winner) {
                let profit = 0;
                if (winner.odds > 0) {
                    profit = betAmount * (winner.odds / 100);
                } else {
                    profit = betAmount * (100 / Math.abs(winner.odds));
                }
                newBalance += Math.floor(profit) + betAmount;
            }

            const payout = playerWon ? newBalance - balance + betAmount : -betAmount;
            const { round, racers: currentRacers, selectedRacerId: selectedId, roundHistory } = get();
            const selectedRacer = currentRacers.find(r => r.id === selectedId);

            set({
                state: 'Finished',
                winnerId,
                balance: newBalance,
                lastPayout: payout,
                lastResult: {
                    winnerId,
                    winnerName: winner?.name || 'Unknown',
                    playerWon,
                    payout: playerWon ? payout : 0,
                    newBalance,
                },
                roundHistory: [
                    ...roundHistory,
                    {
                        round,
                        winnerId,
                        winnerName: winner?.name || 'Unknown',
                        playerWon,
                        payout,
                        selectedRacerName: selectedRacer?.name || 'Unknown',
                    },
                ],
            });
        }
    },

    nextRound: async () => {
        const { isOnline, sessionId, round, maxRounds } = get();

        if (isOnline && sessionId) {
            set({ isLoading: true });
            try {
                const newState = await api.nextRound(sessionId);
                set({ ...newState, lastResult: null, isLoading: false });
            } catch {
                set({ error: 'Failed to advance round', isLoading: false });
            }
        } else {
            if (round >= maxRounds) {
                set({
                    round: 1,
                    balance: INITIAL_BALANCE,
                    racers: generateRacers(),
                    state: 'Betting',
                    selectedRacerId: null,
                    winnerId: null,
                    lastResult: null,
                    roundHistory: [],
                    lastPayout: 0,
                });
            } else {
                set({
                    round: round + 1,
                    racers: generateRacers(),
                    state: 'Betting',
                    selectedRacerId: null,
                    winnerId: null,
                    lastResult: null,
                    lastPayout: 0,
                });
            }
        }
    },

    setOnlineMode: (online: boolean) => {
        set({ isOnline: online });
        if (online) {
            get().initSession();
        }
    },
}));
