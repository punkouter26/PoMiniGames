/**
 * usePoInputModeStore.ts — Tiny Zustand store for input mode selection.
 * 'swipe'     = default flick-upward mechanic
 * 'slingshot' = pull-back-and-release mechanic
 */

import { create } from 'zustand';

export type PoInputMode = 'swipe' | 'slingshot';

interface PoInputModeStore {
    inputMode: PoInputMode;
    setInputMode: (mode: PoInputMode) => void;
    toggleInputMode: () => void;
}

export const usePoInputModeStore = create<PoInputModeStore>()((set, get) => ({
    inputMode: 'swipe',
    setInputMode: (mode) => set({ inputMode: mode }),
    toggleInputMode: () =>
        set({ inputMode: get().inputMode === 'swipe' ? 'slingshot' : 'swipe' }),
}));
