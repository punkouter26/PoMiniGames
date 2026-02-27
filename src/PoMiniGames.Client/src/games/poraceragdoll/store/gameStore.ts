import { create } from 'zustand';
import { api, type GameState, type Racer, type RaceResult } from '../lib/api';
import { INITIAL_BALANCE, INITIAL_BET, TOTAL_ROUNDS, RACER_SPECIES } from '../lib/config';

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
            odds: 100
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

    initSession: () => Promise<void>;
    selectRacer: (id: number) => void;
    placeBet: () => Promise<void>;
    finishRace: (winnerId: number) => Promise<void>;
    nextRound: () => Promise<void>;
    setOnlineMode: (online: boolean) => void;
    hydrate: () => void;
}

export const useGameStore = create<GameStore>((set, get) => ({
    sessionId: null,
    balance: INITIAL_BALANCE,
    round: 1,
    maxRounds: TOTAL_ROUNDS,
    state: 'BETTING',
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

    hydrate: () => {
        const { isHydrated } = get();
        if (!isHydrated) {
            set({ racers: generateRacers(), isHydrated: true });
            api.checkHealth().then(healthy => {
                if (healthy) {
                    get().setOnlineMode(true);
                }
            }).catch(() => {
                // API not available, offline mode
            });
        }
    },

    initSession: async () => {
        const { isOnline } = get();
        if (!isOnline) return;
        set({ isLoading: true, error: null });
        try {
            const { sessionId, state } = await api.createSession();
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
        if (gameState !== 'BETTING' || selectedRacerId === null) return;
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
            set({ balance: balance - betAmount, state: 'RACING' });
        }
    },

    finishRace: async (winnerId: number) => {
        const { isOnline, sessionId, selectedRacerId, racers, betAmount, balance } = get();

        if (isOnline && sessionId) {
            set({ isLoading: true });
            try {
                const { state, result } = await api.finishRace(sessionId, winnerId);
                set({ ...state, lastResult: result, isLoading: false });
            } catch {
                set({ error: 'Failed to finish race', isLoading: false });
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
                state: 'FINISHED',
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
                    state: 'BETTING',
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
                    state: 'BETTING',
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
