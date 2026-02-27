import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { get, set, del } from 'idb-keyval';

interface GameState {
    unlockedLevels: number;
    highScores: Record<number, number>;
    currentLevel: number;
    unlockLevel: (_level: number) => void;
    setHighScore: (_level: number, _score: number) => void;
    setCurrentLevel: (_level: number) => void;
    resetProgress: () => void;
    p1FighterId: string;
    p2FighterId: string;
    setP1FighterId: (id: string) => void;
    setP2FighterId: (id: string) => void;
}

const storage = {
    getItem: async (name: string): Promise<string | null> => {
        return (await get(name)) || null;
    },
    setItem: async (name: string, value: string): Promise<void> => {
        await set(name, value);
    },
    removeItem: async (name: string): Promise<void> => {
        await del(name);
    },
};

export const useGameStore = create<GameState>()(
    persist(
        (set) => ({
            unlockedLevels: 1,
            highScores: {},
            currentLevel: 1,
            unlockLevel: (level) =>
                set((state) => ({
                    unlockedLevels: Math.max(state.unlockedLevels, level),
                })),
            setHighScore: (level, score) =>
                set((state) => ({
                    highScores: {
                        ...state.highScores,
                        [level]: Math.max(state.highScores[level] || 0, score),
                    },
                })),
            setCurrentLevel: (level) => set({ currentLevel: level }),
            resetProgress: () => set({ unlockedLevels: 1, highScores: {}, currentLevel: 1 }),
            p1FighterId: 'player',
            p2FighterId: 'fighter2',
            setP1FighterId: (id) => set({ p1FighterId: id }),
            setP2FighterId: (id) => set({ p2FighterId: id }),
        }),
        {
            name: 'pofight-storage',
            storage: createJSONStorage(() => storage),
        }
    )
);
