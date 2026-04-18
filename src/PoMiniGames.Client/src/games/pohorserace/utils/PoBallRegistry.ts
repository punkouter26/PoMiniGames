/**
 * PoBallRegistry.ts — Module-level registry mapping ball id → live Rapier
 * translation getter.
 *
 * PoBall registers itself on mount and unregisters on unmount so that the
 * DEV test bridge in main.tsx can read real-time physics positions without
 * touching React state or triggering re-renders.
 *
 * This module exports a plain singleton object; it is safe to import from
 * both PoBall (inside the Canvas) and main.tsx (outside the Canvas) because
 * Vite will bundle it as a single module instance.
 *
 * Production builds use this too (it's just a Map); tree-shaking removes the
 * test-bridge consumer in main.tsx so no runtime cost is incurred outside DEV.
 */

interface PositionSnapshot {
  x: number;
  y: number;
  z: number;
}

type PositionGetter = () => PositionSnapshot;

const _registry = new Map<number, PositionGetter>();

export const PoBallRegistry = {
  /**
   * Called by PoBall on mount. `getter` should call body.translation() and
   * return { x, y, z }.
   */
  register(id: number, getter: PositionGetter): void {
    _registry.set(id, getter);
  },

  /** Called by PoBall on unmount (cleanup). */
  unregister(id: number): void {
    _registry.delete(id);
  },

  /**
   * Returns the current world-space Rapier translation for every registered
   * ball, or null for each axis if the rigid body hasn't settled yet.
   */
  getPositions(): Array<{ id: number } & PositionSnapshot> {
    return Array.from(_registry.entries()).map(([id, getter]) => ({
      id,
      ...getter(),
    }));
  },
};
