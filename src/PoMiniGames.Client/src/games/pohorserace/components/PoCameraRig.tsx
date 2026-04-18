/**
 * PoCameraRig.tsx — Applies orbit / race camera spring values to the R3F camera.
 *
 * This is a render-less component (returns null). It lives inside the Canvas
 * and uses `useFrame` to mutate the camera position and lookAt target every
 * frame based on the springs produced by usePoOrbitCamera.
 *
 * Camera modes
 * ------------
 *  • Race  (default):     position [0, 0, 14]  →  lookAt [0, 0, 0]
 *  • Orbit (Finished):    position [finishX-0.5, winnerY+1.5, 5]  →  lookAt [finishX, winnerY, 0]
 *    Transition uses Slow-In/Out easing (see usePoOrbitCamera for config).
 */

import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { usePoOrbitCamera } from '../hooks/usePoOrbitCamera';

const _lookAtTarget = new THREE.Vector3();

export function PoCameraRig(): null {
  const { camera } = useThree();
  const { springs } = usePoOrbitCamera();

  // Stable THREE.Vector3 refs to avoid per-frame allocation.
  const targetRef = useRef(new THREE.Vector3());

  useFrame(() => {
    // Read current spring values.
    const px = springs.springPosX.get();
    const py = springs.springPosY.get();
    const pz = springs.springPosZ.get();
    const tx = springs.springTgtX.get();
    const ty = springs.springTgtY.get();
    const tz = springs.springTgtZ.get();

    camera.position.set(px, py, pz);

    targetRef.current.set(tx, ty, tz);
    _lookAtTarget.copy(targetRef.current);
    camera.lookAt(_lookAtTarget);

    camera.updateProjectionMatrix();
  });

  return null;
}
