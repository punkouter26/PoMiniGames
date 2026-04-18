/**
 * PoHorse.tsx — 3D horse primitive on the Horse Wall.
 *
 * Position: positionInches (0–60) is interpolated via react-spring to X world-units.
 * Movement: right → left.  positionInches=0 → X=PO_HORSE_BASE_X (right).
 *                           positionInches=60 → X=PO_HORSE_BASE_X−6.0 (left).
 * Scale: PO_INCHES_TO_WORLD = 0.1  ->  60 inches = 6 world units of travel.
 *
 * C1 fix: spring animation lives HERE (component), not in the Zustand store.
 * Reset slide-back (FR-006): when positionInches drops, a fast spring config
 * { mass:1, tension:400, friction:20 } powers the high-speed reverse slide.
 *
 * Gold glow (FR-004): emissiveIntensity is set to 2.0 when goldGlowActive;
 * pulsing bloom effect is deferred to Phase 5 (T057).
 */

import type { JSX } from 'react';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useSpring, animated } from '@react-spring/three';
import type { PoLane, PoLaneColor } from '../types/po-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PO_INCHES_TO_WORLD = 0.333; // 1 inch = 0.333 world units (60" = 20 world units)

/**
 * Starting X for all horses (RIGHT edge of the race track).
 * At positionInches=60: X = PO_HORSE_BASE_X − 60 * PO_INCHES_TO_WORLD = 10 − 20 = −10 (finish, left edge).
 */
export const PO_HORSE_BASE_X = 10.0;

/** Finish X (left edge) derived from the 60-inch track length. */
export const PO_HORSE_FINISH_X = PO_HORSE_BASE_X - 60 * PO_INCHES_TO_WORLD; // -10.0

/**
 * World-space Z for all wall horses — placed on the wall face (Z ≈ −0.2),
 * in front of the backdrop plane (Z = −0.3) but behind the ramp (Z ≈ 0).
 */
export const PO_HORSE_WALL_Z = -0.18;

/**
 * Gold glow (FR-004): emissiveIntensity spring from 0 → 2.5 in 400ms (T058).
 * pulsing bloom via SelectiveBloom on layer 1 (T063).
 */

/** Hex colour lookup keyed by PoLaneColor variant — canonical game colours (FR-033, T058). */
export const PO_LANE_COLOR_HEX: Record<PoLaneColor, string> = {
  PoRed: '#CC2200',
  PoBlue: '#1155CC',
  PoYellow: '#DDAA00',
  PoGreen: '#228833',
  PoOrange: '#DD6600',
  PoPurple: '#7722AA',
  PoPink: '#DD44AA',
  PoWhite: '#EEEEEE',
};

const BODY_W = 0.55;
const BODY_H = 0.65;
const BODY_D = 0.25;

// ---------------------------------------------------------------------------
// PoHorse
// ---------------------------------------------------------------------------

interface PoHorseProps {
  lane: PoLane;
  /** World-space Y position (lane row, constant). */
  y: number;
}

export function PoHorse({ lane, y }: PoHorseProps): JSX.Element {
  const prevInchesRef = useRef(lane.positionInches);
  const isReset = lane.positionInches < prevInchesRef.current;
  prevInchesRef.current = lane.positionInches;

  // Horses move RIGHT → LEFT: higher positionInches = more negative X.
  const targetX = PO_HORSE_BASE_X - lane.positionInches * PO_INCHES_TO_WORLD;

  const { posX } = useSpring({
    posX: targetX,
    config: isReset
      ? { mass: 1, tension: 400, friction: 20 }
      : { mass: 1, tension: 120, friction: 14 },
  });

  // T058: Gold glow emissiveIntensity spring 0 → 2.5 in 400ms (FR-004).
  const { emissiveGlow } = useSpring({
    emissiveGlow: lane.goldGlowActive ? 2.5 : 0,
    config: { duration: 400 },
  });

  // T063: Selective Bloom layer 1 — enable on body/head meshes when glowing.
  const bodyRef = useRef<THREE.Mesh>(null);
  const headRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const enable = lane.goldGlowActive;
    [bodyRef.current, headRef.current].forEach(m => {
      if (!m) return;
      if (enable) m.layers.enable(1);
      else m.layers.disable(1);
    });
  }, [lane.goldGlowActive]);

  const hex = PO_LANE_COLOR_HEX[lane.color];
  const emissiveTint = lane.goldGlowActive ? '#FFD700' : hex;

  return (
    // X is animated (moves left); Y is constant (lane row).
    <animated.group position-x={posX} position-y={y} position-z={PO_HORSE_WALL_Z}>
      {/* Horse body */}
      <mesh ref={bodyRef}>
        <boxGeometry args={[BODY_H, BODY_W, BODY_D]} />
        <animated.meshStandardMaterial
          color={hex}
          emissive={emissiveTint}
          emissiveIntensity={emissiveGlow}
          roughness={0.6}
          metalness={0.1}
        />
      </mesh>

      {/* Horse head — offset to the LEFT (direction of movement) */}
      <mesh ref={headRef} position={[-(BODY_H * 0.55), BODY_W * 0.2, 0]}>
        <boxGeometry args={[BODY_H * 0.35, BODY_W * 0.5, BODY_D]} />
        <animated.meshStandardMaterial
          color={hex}
          emissive={emissiveTint}
          emissiveIntensity={emissiveGlow}
          roughness={0.6}
          metalness={0.1}
        />
      </mesh>

      {/* Lane-base dot */}
      <mesh position={[0, -(BODY_W * 0.5 + 0.08), 0]}>
        <sphereGeometry args={[0.08, 8, 8]} />
        <meshStandardMaterial color={hex} emissive={hex} emissiveIntensity={0.5} />
      </mesh>
    </animated.group>
  );
}
