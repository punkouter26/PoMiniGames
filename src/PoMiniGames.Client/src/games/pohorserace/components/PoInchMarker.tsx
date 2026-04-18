/**
 * PoInchMarker.tsx — 60 low-profile ridge markers along the lane surface.
 * T041 [P] [US2]
 *
 * Rendered as a single <instancedMesh> of 60 thin box instances for perf (FR-017).
 * Rapier sensor per marker: onCollisionEnter fires PoAudioService.playRumble(speed).
 * Height is 3mm (0.003 world units) so it doesn't impede ball rolling.
 *
 * Props:
 *  laneWorldX  — lane's world-space X position
 *  rampLength  — total ramp length (RAMP_LEN from PoLaneRamp)
 */

import type { JSX } from 'react';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { poAudioService } from '../services/PoAudioService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKER_COUNT = 60;
const MARKER_W = 0.72;   // slightly narrower than lane
const MARKER_H = 0.006;  // 6mm — visible but not obstructive
const MARKER_D = 0.015;  // 15mm ridge depth
const SLAB_T   = 0.05;   // must match PoLaneRamp SLAB_T

interface PoInchMarkerProps {
  rampLength: number;
}

// ---------------------------------------------------------------------------
// PoInchMarker
// ---------------------------------------------------------------------------

export function PoInchMarker({ rampLength }: PoInchMarkerProps): JSX.Element {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  // Build instance matrices once
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useMemo(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < MARKER_COUNT; i++) {
      // Distribute markers evenly from near end to far end of ramp surface
      const t = (i + 0.5) / MARKER_COUNT;
      const z = rampLength / 2 - t * rampLength; // -len/2 (far) → +len/2 (near)
      dummy.position.set(0, SLAB_T / 2 + MARKER_H / 2, z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [dummy, rampLength]);

  const handleCollision = (speed: number) => {
    poAudioService.playRumble(speed);
  };

  // NOTE: Rapier sensor integration (onCollisionEnter) wired in T047 (usePoPhysicsSync).
  // This component currently provides the visual geometry; physics colliders
  // are added by the parent lane component in Phase 5 (T055).
  void handleCollision; // keep linter quiet until T047 wires it

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, MARKER_COUNT]}
      castShadow={false}
      receiveShadow={false}
    >
      <boxGeometry args={[MARKER_W, MARKER_H, MARKER_D]} />
      <meshStandardMaterial color="#ffffff" roughness={0.8} metalness={0.0} opacity={0.35} transparent />
    </instancedMesh>
  );
}
