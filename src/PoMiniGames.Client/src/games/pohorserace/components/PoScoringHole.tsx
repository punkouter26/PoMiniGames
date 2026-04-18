/**
 * PoScoringHole.tsx — One scoring hole: torus aperture + raised rim + sensor.
 * T043 [P] [US2]
 *
 * Visual:
 *  • Dark aperture disc (circleGeometry) — where the ball drops in
 *  • Glowing rim ring (torusGeometry, coloured by pointValue)
 *  • Raised bump cylinder ring (CylinderGeometry) for ball deflection
 *
 * Physics (Rapier):
 *  • CuboidCollider sensor on hole opening — onIntersectionEnter fires onScore()
 *  • CylinderCollider for the rim bump — deflects balls that graze the edge
 *
 * Props:
 *  hole      — PoScoringHole data (id, row, pointValue)
 *  lx / lz   — local position on ramp surface (already ramp-local)
 *  onScore   — callback(holeId, points) fired when ball enters sensor
 */

import type { JSX } from 'react';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import type { PoScoringHole as PoScoringHoleType } from '../types/po-types';

// ---------------------------------------------------------------------------
// Colour by point value
// ---------------------------------------------------------------------------

const POINT_COLOR: Record<1 | 2 | 3 | 5, string> = {
  1: '#cc44ff', // purple — base (2 holes)
  2: '#60a0ff', // blue   — middle (2 holes)
  3: '#44ff44', // green  — upper row
  5: '#ffffff', // white  — apex
};

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

const HOLE_R = 0.204;   // inner aperture radius (×2 ×0.8)
const TUBE_R = 0.053;   // torus tube radius (×2 ×0.8)
const RIM_H = 0.04;     // raised rim height
const RIM_WALL = 0.043; // rim wall thickness (×2 ×0.8)
const SLAB_Y = 0.028;   // slightly raised above 0.026 to prevent Z-fighting with white decor rings

// ---------------------------------------------------------------------------
// PoScoringHole
// ---------------------------------------------------------------------------

interface PoScoringHoleProps {
  hole: PoScoringHoleType;
  lx: number;
  lz: number;
  laneId: number;
  onScore: (holeId: number, points: number, ballId: number | null, laneId: number) => void;
}

export function PoScoringHole({ hole, lx, lz, laneId, onScore }: PoScoringHoleProps): JSX.Element {
  const rimColor = POINT_COLOR[hole.pointValue];

  return (
    <group position={[lx, SLAB_Y, lz]}>
      {/* ── Dark aperture disc ─────────────────────────────────────────── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.002, 0]}>
        <circleGeometry args={[HOLE_R, 24]} />
        <meshStandardMaterial color="#050505" roughness={1} />
      </mesh>

      {/* ── Visual and Physical Rim (Torus + Cylinder) ────────────── */}
      <RigidBody type="fixed" colliders="trimesh">
        <group>
          {/* Torus rim (decorative glow ring, now also physical) */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, TUBE_R * 0.5, 0]}>
            <torusGeometry args={[HOLE_R, TUBE_R, 10, 28]} />
            <meshStandardMaterial
              color={rimColor}
              emissive={rimColor}
              emissiveIntensity={0.8}
              roughness={0.3}
              metalness={0.5}
            />
          </mesh>

          {/* Raised cylinder rim (visible bump + deflection geometry) */}
          <mesh position={[0, RIM_H / 2, 0]}>
            <cylinderGeometry args={[HOLE_R + RIM_WALL, HOLE_R + RIM_WALL, RIM_H, 24, 1, true]} />
            <meshStandardMaterial
              color={rimColor}
              emissive={rimColor}
              emissiveIntensity={0.4}
              roughness={0.4}
              metalness={0.4}
              side={2} // THREE.DoubleSide
            />
          </mesh>
        </group>
      </RigidBody>

      {/* ── Rapier physics ─────────────────────────────────────────────── */}

      {/* Sensor: positioned below the surface to catch balls fully falling through */}
      <RigidBody type="fixed" colliders={false} sensor>
        <CuboidCollider
          args={[HOLE_R * 0.85, 0.1, HOLE_R * 0.85]}
          position={[0, -0.15, 0]}
          sensor
          onIntersectionEnter={(event) => {
            const rbUserData = event.other.rigidBodyObject?.userData as
              | { ballId?: number; laneId?: number }
              | undefined;
            const scoredBallId = typeof rbUserData?.ballId === 'number' ? rbUserData.ballId : null;
            const scoredLaneId = typeof rbUserData?.laneId === 'number' ? rbUserData.laneId : laneId;
            onScore(hole.id, hole.pointValue, scoredBallId, scoredLaneId);
          }}
        />
      </RigidBody>
    </group>
  );
}
