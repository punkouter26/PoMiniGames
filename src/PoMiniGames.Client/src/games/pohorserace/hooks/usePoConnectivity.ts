/**
 * usePoConnectivity.ts — Offline-first connectivity indicator hook.
 *
 * Constitution Principle II MUST: provide a visible, non-intrusive indicator
 * when the app is operating offline (C2 fix — cannot be waived as vacuously satisfied).
 *
 * This app is permanently offline-first (FR-031); there is no server component
 * in v1.0. The hook always returns { isOffline: true, mode: 'offline' }.
 * If a future version adds an API endpoint, this hook would need to be updated
 * to monitor navigator.onLine / network events.
 */

export interface PoConnectivityState {
  isOffline: true;
  mode: 'offline';
}

/**
 * Returns the current connectivity mode.
 * In v1.0 this is always { isOffline: true, mode: 'offline' } because the app
 * has no backend. The offline pill in PoScene.tsx consumes this hook.
 */
export function usePoConnectivity(): PoConnectivityState {
  return { isOffline: true, mode: 'offline' };
}
