/**
 * PoTrough.tsx — Ball container at the near/player end of lane 1.
 * T045 [US2]
 *
 * Renders up to 3 <PoBall> components for balls with phase==='InTrough'.
 * In-flight / Scoring / Returning balls are rendered by PoLane (Phase 5, T055).
 * In Phase 4 (pre-T055), ALL balls are rendered here regardless of phase
 * so they are visible and physics-active in the scene.
 *
 * The trough itself is a curved concave mesh sitting at the near (player) end
 * of the ramp. Three ball slots are spaced across the lane width.
 *
 * Swipe input is captured here via usePoSwipeInput — the canvas pointer events
 * propagate down from PoScene's <Canvas onPointer*> to this mesh.
 */

import type { JSX } from 'react';
import { usePoBallStore } from '../store/usePoBallStore';
import { PoBall, BALL_RADIUS } from './PoBall';

// ---------------------------------------------------------------------------
// Layout constants (ramp-local space)
// ---------------------------------------------------------------------------

const TROUGH_Z = 2.4;    // near-player end of ramp, local Z (positive = toward player)
const SLAB_Y = 0.026;  // surface level

/** Horizontal spacing of 3 ball slots within the trough. */
const SLOT_X = [-0.22, 0, 0.22];

// ---------------------------------------------------------------------------
// PoTrough
// ---------------------------------------------------------------------------

interface PoTroughProps {
  laneId: number;
}

export function PoTrough({ laneId }: PoTroughProps): JSX.Element {
  const allBalls = usePoBallStore(s => s.balls);
  const laneBalls = allBalls.filter(b => b.laneId === laneId);

  return (
    // Trough sits in ramp-local space — caller (PoLanePhysics) must place in right group
    <group name="PoTrough">
      {/* ── All 3 balls — always white, any can be grabbed and thrown ── */}
      {laneBalls.map((ball) => (
        <group
          key={ball.id}
          position={[SLOT_X[ball.id % 3]!, SLAB_Y + BALL_RADIUS + 0.005, TROUGH_Z]}
        >
          <PoBall ball={ball} />
        </group>
      ))}
    </group>
  );
}
