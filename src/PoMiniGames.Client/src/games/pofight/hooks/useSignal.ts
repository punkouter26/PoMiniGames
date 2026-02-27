import { useSyncExternalStore, useCallback } from 'react';
import { Signal } from '../engine/Signals';

/**
 * React hook to subscribe to a Signal using useSyncExternalStore.
 * This provides automatic SSR support and better React 18 integration.
 * 
 * @param signal - The Signal instance to subscribe to
 * @returns The current value of the signal
 */
export function useSignal<T>(signal: Signal<T>): T {
    const subscribe = useCallback(
        (onStoreChange: () => void) => {
            return signal.subscribe(onStoreChange);
        },
        [signal]
    );

    const getSnapshot = useCallback(() => signal.value, [signal]);

    // For SSR, we use the same snapshot function
    const getServerSnapshot = useCallback(() => signal.value, [signal]);

    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Hook to get a signal's value without causing re-renders.
 * Useful for event handlers or effects where you need the current value
 * but don't want to subscribe to changes.
 * 
 * @param signal - The Signal instance
 * @returns A function that returns the current value
 */
export function useSignalRef<T>(signal: Signal<T>): () => T {
    return useCallback(() => signal.peek(), [signal]);
}
