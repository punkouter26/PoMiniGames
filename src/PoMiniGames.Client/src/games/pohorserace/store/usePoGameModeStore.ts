import { create } from 'zustand';
import type { PoGameMode } from '../types/po-types';

interface PoGameModeStore {
  gameMode: PoGameMode;
  setGameMode: (mode: PoGameMode) => void;
}

export const usePoGameModeStore = create<PoGameModeStore>()((set) => ({
  gameMode: 'normal',
  setGameMode: (mode) => set({ gameMode: mode }),
}));
