/**
 * usePoPhysicsSync.ts — useFrame physics sync + audio routing.
 * T047 [US2]
 *
 * SOLID S: This hook is solely responsible for synchronising Rapier physics
 * state with Zustand transient stores and routing contact-force events to
 * PoAudioService. It does NOT apply impulses (that's usePoSwipeInput).
 *
 * Responsibilities:
 *  1. useFrame: read ball rigid-body positions, update usePoBallStore positions
 *     (transient write — no React re-render triggered).
 *  2. Route onContactForce events from PoInchMarker colliders → PoAudioService.playRumble
 *  3. Route onContactEnd events → PoAudioService.stopRumble
 *  4. Guard: no-op when phase !== 'Racing'
 *
 * Usage: mount once inside the <Physics> boundary in PoScene or PoMidway.
 * Returns { onInchMarkerContact, onInchMarkerContactEnd } for use by PoInchMarker.
 */

import { useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import { usePoBallStore } from '../store/usePoBallStore';
import { usePoRaceStore } from '../store/usePoRaceStore';
import { poAudioService } from '../services/PoAudioService';
import type { CollisionEnterPayload, CollisionExitPayload } from '@react-three/rapier';

// ---------------------------------------------------------------------------
// usePoPhysicsSync
// ---------------------------------------------------------------------------

export function usePoPhysicsSync() {
  const getPhase   = usePoRaceStore.getState;
  const getBalls   = usePoBallStore.getState;

  // useFrame: sync Rapier rigid body positions → store (transient, no re-render)
  useFrame(() => {
    const { phase } = getPhase();
    if (phase !== 'Racing') return;

    // Positional sync is managed by the ball's own RigidBody in Phase 4.
    // Full sync (reading translation) wired in Phase 5 when PoLane mounts balls.
    // This hook runs the guard and keeps the extension point open.
    void getBalls;
  });

  // Contact event handlers for PoInchMarker ridges
  const onInchMarkerContact = useCallback((payload: CollisionEnterPayload) => {
    const { phase } = getPhase();
    if (phase !== 'Racing') return;

    // Estimate speed from rigid body linear velocity
    const vel = payload.rigidBody?.linvel() ?? { x: 0, y: 0, z: 0 };
    const speed = Math.min(Math.sqrt(vel.x ** 2 + vel.y ** 2 + vel.z ** 2) * 2.237, 30); // m/s → mph proxy
    poAudioService.playRumble(speed);
  }, [getPhase]);

  const onInchMarkerContactEnd = useCallback((_payload: CollisionExitPayload) => {
    poAudioService.stopRumble();
  }, []);

  // T061: Contact handler for PoScoringHole raised rim colliders → rim-clack audio.
  const onScoringHoleRimContact = useCallback((payload: CollisionEnterPayload) => {
    const { phase } = getPhase();
    if (phase !== 'Racing') return;

    // Use linear velocity magnitude as a proxy for impact force.
    const vel = payload.rigidBody?.linvel() ?? { x: 0, y: 0, z: 0 };
    const velocity = Math.min(Math.sqrt(vel.x ** 2 + vel.y ** 2 + vel.z ** 2) / 14, 1);
    poAudioService.playRimClack(velocity);
  }, [getPhase]);

  return { onInchMarkerContact, onInchMarkerContactEnd, onScoringHoleRimContact };
}
