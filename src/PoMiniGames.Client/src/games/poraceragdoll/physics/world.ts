import type { World } from '@dimforge/rapier3d-compat';

// Collision groups
export const COLLISION_GROUPS = {
    RACER: 0x00010001,
    ENVIRONMENT: 0x00020002
};

export const GRAVITY = { x: 0.0, y: -9.81, z: 0.0 };

export const PHYSICS_CONFIG = {
    timeStep: 1 / 60,
    substeps: 4
};

// Re-export for convenience
export type { World };
