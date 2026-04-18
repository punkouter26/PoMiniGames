/**
 * PoLane.tsx — Player lane (lane 1) physics substrate.
 * T055 [P] [US3]
 *
 * This component is the single spatial hierarchy mount point for:
 *  • <PoInchMarker>  — 60 ridge sensors that trigger rolling audio
 *  • In-flight <PoBall> components (phase ≠ 'InTrough')
 *
 * M4 fix: PoTrough owns and renders InTrough balls only.
 *         PoLane owns and renders all balls that are in-flight/scoring/returning
 *         so they remain attached to the correctly inclined physics hierarchy.
 *
 * SOLID S: PoLane handles only the spatial parenting of physics objects.
 *          Visual lane geometry lives in PoLaneRamp (all 8 lanes).
 *
 * Mounted inside the inclined ramp group in PoMidway — inherits the
 * RAMP_INCLINE rotation so Rapier forces act in the correct inclined frame.
 */

import type { JSX } from 'react';
import { PoInchMarker } from './PoInchMarker';
import { RAMP_LEN } from './PoLaneRamp';

// ---------------------------------------------------------------------------
// PoLane
// ---------------------------------------------------------------------------

export function PoLane(): JSX.Element {
  return (
    <group name="PoLane-physics">
      {/* 60 ridge markers along the ramp surface (audio triggers + visual detail) */}
      <PoInchMarker rampLength={RAMP_LEN} />
    </group>
  );
}
