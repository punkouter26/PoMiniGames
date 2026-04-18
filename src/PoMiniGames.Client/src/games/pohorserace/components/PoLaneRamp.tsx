/**
 * PoLaneRamp.tsx — 8 coloured inclined rolling lanes with 10 scoring holes each.
 *
 * Physical layout (matches real Roll-A-Ball Horse Racing machine):
 *  • Each lane is a thin box tilted ~10° around X so the far end (backdrop side)
 *    is raised — this is the inclined ramp the ball rolls along.
 *  • 10 holes sit flat ON the ramp surface near the far/scoring end, arranged in
 *    a 4-3-2-1 triangle (bowling-pin/pyramid pattern pointing toward backdrop).
 *  • Holes are torus geometry with rotation matching the ramp tilt so they lie
 *    flush with the lane surface.
 *  • Lane colours come from PO_LANE_COLOR_HEX (same palette as PoHorse).
 *
 * Coordinate conventions (ramp-local space, inside the tilted group):
 *  +X = cross-lane (right)            Y = normal to ramp surface (up from surface)
 *  +Z = toward player / camera        −Z = toward backdrop / scoring end
 */

import type { JSX } from 'react';
import { useMemo } from 'react';
import * as THREE from 'three';
import { RigidBody, CuboidCollider } from '@react-three/rapier';
import { PO_LANE_X_POSITIONS } from './PoHorseWall';
import { PO_LANE_COLOR_HEX } from './PoHorse';
import type { PoLaneColor } from '../types/po-types';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Lane colours in order (index = laneId − 1). */
const LANE_COLORS: PoLaneColor[] = [
  'PoRed', 'PoBlue', 'PoYellow', 'PoGreen',
  'PoOrange', 'PoPurple', 'PoPink', 'PoWhite',
];

/** Width of each lane slab (leaves a small gap between neighbours). */
const LANE_W = 2.58;

/** Length of the ramp from near-player end to backdrop end. */
export const RAMP_LEN = 5.5;

/** Slab thickness. */
export const SLAB_T = 0.05;

/** Ramp incline: raises the far (backdrop) end, tilts the near end down. */
export const RAMP_INCLINE = Math.PI / 9; // 20°

/** World-space position of the ramp group centre. */
export const RAMP_CENTER_Y = -0.2;
export const RAMP_CENTER_Z = 2.6;

/**
 * World-space Y of the ramp top surface at the far (backdrop) end.
 * = RAMP_CENTER_Y + (RAMP_LEN/2)·sin(10°) + SLAB_T/2
 */
export const RAMP_FAR_END_TOP_Y =
  RAMP_CENTER_Y + (RAMP_LEN / 2) * Math.sin(RAMP_INCLINE) + SLAB_T / 2;

/** Side-gutter wall height above ramp surface. */
const GUTTER_H = 0.18;
const GUTTER_T = 0.03;

// ---------------------------------------------------------------------------
// Hole layout — 4-3-2-1 bowling-pin triangle in ramp-local space
// All positions are offsets from the ramp group centre (Y = ramp surface).
// Negative Z → toward backdrop (scoring end).
// ---------------------------------------------------------------------------
const HOLE_R = 0.168;  // inner radius (×2 ×0.8)
const HOLE_TUBE = 0.060; // tube thickness (×2 ×0.8)
const HOLE_Y = SLAB_T / 2 + 0.001; // just above the slab top face

const HOLE_ROW_DZ = 0.36;   // Z step between rows (toward backdrop)
const HOLE_Z0 = -1.30;  // local Z of the 4-hole (bottom/near player) row

/** Pre-computed local XZ positions for all 10 holes (4-3-2-1). */
export const PO_HOLE_POSITIONS: readonly { lx: number; lz: number; points: 1 | 2 | 3 | 5 }[] = [
  // Row 0 (Base) — 4 holes, 1 pt  (lx ×2)
  { lx: -0.81, lz: HOLE_Z0, points: 1 },
  { lx: -0.27, lz: HOLE_Z0, points: 1 },
  { lx: 0.27, lz: HOLE_Z0, points: 1 },
  { lx: 0.81, lz: HOLE_Z0, points: 1 },
  // Row 1 — 3 holes, 2 pts  (lx ×2)
  { lx: -0.54, lz: HOLE_Z0 - HOLE_ROW_DZ, points: 2 },
  { lx: 0.00, lz: HOLE_Z0 - HOLE_ROW_DZ, points: 2 },
  { lx: 0.54, lz: HOLE_Z0 - HOLE_ROW_DZ, points: 2 },
  // Row 2 — 2 holes, 3 pts  (lx ×2)
  { lx: -0.27, lz: HOLE_Z0 - HOLE_ROW_DZ * 2, points: 3 },
  { lx: 0.27, lz: HOLE_Z0 - HOLE_ROW_DZ * 2, points: 3 },
  // Row 3 (Apex) — 1 hole, 5 pts
  { lx: 0.00, lz: HOLE_Z0 - HOLE_ROW_DZ * 3, points: 5 },
];

const POINT_COLOR: Record<1 | 2 | 3 | 5, string> = {
  1: '#cc44ff', // purple — base (4 holes)
  2: '#60a0ff', // blue   — row 3 (3 holes)
  3: '#44ff44', // green  — row 2 (2 holes)
  5: '#ffffff', // white  — apex  (1 hole)
};

// ---------------------------------------------------------------------------
// Sub-component: one hole (torus rim + dark aperture disc)
// ---------------------------------------------------------------------------
interface HoleProps {
  lx: number;
  lz: number;
  rimHex: string;
}

function Hole({ lx, lz, rimHex }: HoleProps): JSX.Element {
  return (
    <group position={[lx, HOLE_Y, lz]}>
      {/* Dark aperture — small flat disc slightly below rim */}
      <mesh position={[0, -0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[HOLE_R, 20]} />
        <meshStandardMaterial color="#0a0a0a" roughness={1} />
      </mesh>

      {/* Raised rim — torus lying flat on the ramp surface */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[HOLE_R, HOLE_TUBE, 12, 24]} />
        <meshStandardMaterial
          color={rimHex}
          emissive={rimHex}
          emissiveIntensity={0.45}
          roughness={0.3}
          metalness={0.6}
        />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: one full lane (ramp + gutters + 10 holes)
// ---------------------------------------------------------------------------
interface LaneRampProps {
  worldX: number;
  color: string;
}

function LaneRamp({ worldX, color }: LaneRampProps): JSX.Element {
  /**
   * Slab geometry with actual circular holes.
   * Shape is defined in XY plane, then rotated -90° around X to lie in XZ (ramp surface).
   * Physical hole radius = HOLE_R * 1.35 so balls drop in easily.
   */
  const holedSlabGeometry = useMemo(() => {
    const shape = new THREE.Shape();
    // Rectangle outline (ramp surface in XY → mapped to XZ after rotation)
    const hw = LANE_W / 2;
    const hl = RAMP_LEN / 2;
    shape.moveTo(-hw, -hl);
    shape.lineTo(hw, -hl);
    shape.lineTo(hw, hl);
    shape.lineTo(-hw, hl);
    shape.closePath();

    // Punch out a circular hole at each scoring position.
    // rotateX(-PI/2) maps Shape Y -> ramp-local -Z, so we negate lz here
    // to keep collider cutouts aligned with decorative hole meshes.
    const physHoleR = HOLE_R * 1.35; // slightly larger than visual for gameplay
    PO_HOLE_POSITIONS.forEach(({ lx, lz }) => {
      const hole = new THREE.Path();
      hole.absarc(lx, -lz, physHoleR, 0, Math.PI * 2, false);
      shape.holes.push(hole);
    });

    const geom = new THREE.ExtrudeGeometry(shape, { depth: SLAB_T, bevelEnabled: false });
    // Rotate so shape's XY becomes ramp-local XZ and extrusion goes downward (-Y)
    geom.rotateX(-Math.PI / 2);
    // After rotation: top face at Y=0, bottom at Y=-SLAB_T → translate up to centre at Y=0
    geom.translate(0, SLAB_T / 2, 0);
    return geom;
  }, []);

  return (
    <group
      position={[worldX, RAMP_CENTER_Y, RAMP_CENTER_Z]}
      rotation={[RAMP_INCLINE, 0, 0]}
    >
      {/*
        ── Ramp slab: ExtrudeGeometry with circular holes → trimesh collider ──
        This creates REAL circular openings. The trimesh collider has exactly the
        same shape as the visual mesh so balls can only fall through hole centres.
        Physical hole radius = HOLE_R * 1.35 for good gameplay tolerance.
      */}
      <RigidBody type="fixed" colliders="trimesh">
        <mesh receiveShadow>
          <primitive object={holedSlabGeometry} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.55}
            roughness={0.5}
            metalness={0.05}
            side={2}
          />
        </mesh>
      </RigidBody>

      {/* ── Lower Return Ramp (Catch Board) ───────────────────────────────── */}
      <RigidBody type="fixed" colliders="cuboid">
        <mesh position={[0, -0.4, 2]} receiveShadow>
          <boxGeometry args={[LANE_W, SLAB_T, RAMP_LEN + 4]} />
          <meshStandardMaterial color="#888888" roughness={0.8} />
        </mesh>
      </RigidBody>

      {/* ── Lower Return Ramp Left Gutter ─────────────────────────────────── */}
      <RigidBody type="fixed" colliders="cuboid">
        <mesh position={[-(LANE_W / 2 + GUTTER_T / 2), -0.2, 2]}>
          <boxGeometry args={[GUTTER_T, 0.4, RAMP_LEN + 4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </RigidBody>

      {/* ── Lower Return Ramp Right Gutter ────────────────────────────────── */}
      <RigidBody type="fixed" colliders="cuboid">
        <mesh position={[(LANE_W / 2 + GUTTER_T / 2), -0.2, 2]}>
          <boxGeometry args={[GUTTER_T, 0.4, RAMP_LEN + 4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </RigidBody>

      {/* ── Lower Return Ramp End Stop Wall (invisible) ───────────────────── */}
      <RigidBody type="fixed" colliders="cuboid">
        <mesh position={[0, -0.2, 2 + (RAMP_LEN + 4) / 2]}>
          <boxGeometry args={[LANE_W, 0.4, GUTTER_T]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </RigidBody>


      {/* ── Left gutter wall — invisible tall physics collider ─────────────── */}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider
          args={[GUTTER_T / 2, 5.0, RAMP_LEN / 2]}
          position={[-(LANE_W / 2 + GUTTER_T / 2), 5.0 + SLAB_T / 2, 0]}
        />
        {/* Visible left gutter mesh */}
        <mesh position={[-(LANE_W / 2 + GUTTER_T / 2), GUTTER_H / 2 + SLAB_T / 2, 0]}>
          <boxGeometry args={[GUTTER_T, GUTTER_H, RAMP_LEN]} />
          <meshStandardMaterial color="#111111" roughness={0.9} metalness={0.1} />
        </mesh>
      </RigidBody>

      {/* ── Right gutter wall — invisible tall physics collider ────────────── */}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider
          args={[GUTTER_T / 2, 5.0, RAMP_LEN / 2]}
          position={[(LANE_W / 2 + GUTTER_T / 2), 5.0 + SLAB_T / 2, 0]}
        />
        {/* Visible right gutter mesh */}
        <mesh position={[(LANE_W / 2 + GUTTER_T / 2), GUTTER_H / 2 + SLAB_T / 2, 0]}>
          <boxGeometry args={[GUTTER_T, GUTTER_H, RAMP_LEN]} />
          <meshStandardMaterial color="#111111" roughness={0.9} metalness={0.1} />
        </mesh>
      </RigidBody>

      {/*
        ── Near-end backstop (invisible) — prevents balls rolling off player end ──
        Sits flush with the ramp surface at local Z = +RAMP_LEN/2 (player end).
        Height matches gutter walls; width spans full lane including gutters.
        Mesh is invisible (visible={false}); RigidBody still creates the collider.
      */}
      <RigidBody type="fixed" colliders="cuboid">
        <mesh
          position={[0, SLAB_T / 2 + GUTTER_H / 2, RAMP_LEN / 2]}
        >
          <boxGeometry args={[LANE_W + GUTTER_T * 2, GUTTER_H, 0.04]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </RigidBody>

      {/* ── 10 scoring holes (4-3-2-1 triangle on the ramp surface) ───── */}
      {PO_HOLE_POSITIONS.map((h, i) => (
        <Hole key={i} lx={h.lx} lz={h.lz} rimHex={POINT_COLOR[h.points]} />
      ))}

      {/*
        ── Far-end backstop (invisible) — prevents balls rolling off scoring end ──
        Sits at local Z = -RAMP_LEN/2 (backdrop/scoring end).
        Taller than near-end wall to catch fast balls.
      */}
      <RigidBody type="fixed" colliders="cuboid">
        <mesh
          position={[0, SLAB_T / 2 + GUTTER_H / 2, -RAMP_LEN / 2]}
        >
          <boxGeometry args={[LANE_W + GUTTER_T * 2, GUTTER_H * 2, 0.04]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </RigidBody>
    </group>
  );
}

// ---------------------------------------------------------------------------
// PoLaneRamp — renders all 8 lanes
// ---------------------------------------------------------------------------

export function PoLaneRamp(): JSX.Element {
  return (
    <group name="PoLaneRamp">
      {PO_LANE_X_POSITIONS.map((worldX, i) => {
        const color = PO_LANE_COLOR_HEX[LANE_COLORS[i]!];
        return (
          <LaneRamp
            key={i}
            worldX={worldX}
            color={color}
          />
        );
      })}
    </group>
  );
}
