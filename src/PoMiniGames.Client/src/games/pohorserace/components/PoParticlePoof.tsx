/**
 * PoParticlePoof.tsx — Gold particle burst on scoring event.
 * T051 [P] [US2]
 *
 * Uses THREE.InstancedMesh with 40 gold sphere instances.
 * Each instance receives a random upward velocity; positions advance each frame.
 * Opacity fades 1→0 over lifetimeMs via react-spring uniform.
 * SelectiveBloom eligible: instancedMesh.layers.enable(1) on mount.
 * Unmounts itself after lifetimeMs elapses.
 *
 * GoF note: No external GoF pattern — purely a visual component driven by props.
 */

import type { JSX } from 'react';
import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useSpring } from '@react-spring/three';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PARTICLE_COUNT = 40;
const PARTICLE_RADIUS = 0.045;
const GOLD_COLOR = '#ffd700';

interface PoParticlePoofProps {
  /** World-space origin of the scoring hole (ramp-local will be converted by parent). */
  x: number;
  y: number;
  z: number;
  /** How long the poof lasts (ms). Default 1200. */
  lifetimeMs?: number;
  /** Called when the poof animation has finished so parent can unmount. */
  onComplete?: () => void;
}

// ---------------------------------------------------------------------------
// PoParticlePoof
// ---------------------------------------------------------------------------

export function PoParticlePoof({
  x,
  y,
  z,
  lifetimeMs = 1200,
  onComplete,
}: PoParticlePoofProps): JSX.Element {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const mat     = useRef<THREE.MeshStandardMaterial>(null);

  // Random per-particle velocities (seeded once)
  const velocities = useMemo(() => {
    return Array.from({ length: PARTICLE_COUNT }, () => ({
      vx: (Math.random() - 0.5) * 3.0,
      vy: 2.0 + Math.random() * 3.5,
      vz: (Math.random() - 0.5) * 3.0,
    }));
  }, []);

  // Positions accumulate each frame
  const positions = useMemo(
    () => Array.from({ length: PARTICLE_COUNT }, () => ({ px: 0, py: 0, pz: 0 })),
    []
  );

  // Fade opacity spring
  const [{ opacity }] = useSpring(() => ({
    from: { opacity: 1 },
    to:   { opacity: 0 },
    config: { duration: lifetimeMs },
  }));

  // EnableSelectiveBloom layer on mount
  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.layers.enable(1); // SelectiveBloom target layer
    }
    const timeout = setTimeout(() => onComplete?.(), lifetimeMs + 100);
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const v = velocities[i]!;
      const p = positions[i]!;

      p.px += v.vx * delta;
      p.py += v.vy * delta;
      p.pz += v.vz * delta;
      v.vy -= 9.8 * delta; // gravity pulls particles down

      dummy.position.set(p.px, p.py, p.pz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;

    // Sync opacity from spring
    if (mat.current) {
      mat.current.opacity = opacity.get();
    }
  });

  return (
    <group position={[x, y, z]}>
      <instancedMesh ref={meshRef} args={[undefined, undefined, PARTICLE_COUNT]}>
        <sphereGeometry args={[PARTICLE_RADIUS, 6, 6]} />
        <meshStandardMaterial
          ref={mat}
          color={GOLD_COLOR}
          emissive={GOLD_COLOR}
          emissiveIntensity={1.2}
          transparent
          opacity={1}
        />
      </instancedMesh>
    </group>
  );
}
