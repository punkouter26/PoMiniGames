/**
 * PoBall.tsx — Physics-driven skeeball on the inclined lane.
 * T042 + T048 [US2]
 *
 * Physics:
 *  • Rapier RigidBody "dynamic" + SphereCollider (radius 0.1 world units ≈ 1")
 *  • Impulse applied via rigidBodyRef.current.applyImpulse() on swipe release (T048)
 *  • Trough restitution (bounciness) kept low so ball stays on ramp (FR-011)
 *
 * Rendering:
 *  • Ivory/cream MeshStandardMaterial with roughness variation for scuff look
 *
 * Impulse calibration (T048):
 *  8 mph min swipe → impulse ≈ 0.8   (ball just reaches first markers)
 *  28 mph max swipe → impulse ≈ 2.8  (ball reaches scoring zone)
 *  Scale factor: poFromMph converts to world-unit impulse magnitude
 *
 * T049: canLaunch() check happens in usePoSwipeInput before applyImpulse.
 */

import { useRef, useImperativeHandle, useEffect, forwardRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { RigidBody, BallCollider } from '@react-three/rapier';
import type { RapierRigidBody } from '@react-three/rapier';
import type { PoBall as PoBallType } from '../types/po-types';
import { PoBallRegistry } from '../utils/PoBallRegistry';
import { usePoBallStore } from '../store/usePoBallStore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BALL_RADIUS = 0.07;   // reduced from 0.10 to fit inside 0.085 hole

// ---------------------------------------------------------------------------
// Ref handle exposed to usePoSwipeInput (T048)
// ---------------------------------------------------------------------------

export interface PoBallHandle {
  applyImpulse: (ix: number, iy: number, iz: number) => void;
  getPosition: () => { x: number; y: number; z: number };
}

// ---------------------------------------------------------------------------
// PoBall
// ---------------------------------------------------------------------------

interface PoBallProps {
  ball: PoBallType;
}

export const PoBall = forwardRef<PoBallHandle, PoBallProps>(
  function PoBall({ ball }, ref) {
    const rigidBodyRef = useRef<RapierRigidBody>(null);

    useImperativeHandle(ref, () => ({
      applyImpulse(ix, iy, iz) {
        rigidBodyRef.current?.applyImpulse({ x: ix, y: iy, z: iz }, true);
      },
      getPosition() {
        const t = rigidBodyRef.current?.translation();
        return t ? { x: t.x, y: t.y, z: t.z } : { x: 0, y: 0, z: 0 };
      },
    }));

    // Register this ball's rigid body with the test-bridge registry so that
    // e2e tests can read live Rapier world-space positions without React state.
    useEffect(() => {
      PoBallRegistry.register(ball.id, () => {
        const t = rigidBodyRef.current?.translation();
        return t ? { x: t.x, y: t.y, z: t.z } : { x: 0, y: 0, z: 0 };
      });
      return () => PoBallRegistry.unregister(ball.id);
    }, [ball.id]);

    // Recreate the physical rigid body ONLY when returning to the trough.
    // This allows it to physically teleport back to the start slot without
    // losing momentum when transitioning from InTrough -> InFlight.
    const [troughKey, setTroughKey] = useState(0);
    useEffect(() => {
      if (ball.phase === 'InTrough') {
        setTroughKey(k => k + 1);
      }
    }, [ball.phase]);

    // Register imperative handle into global store for swiping
    useEffect(() => {
      const handle: PoBallHandle = {
        applyImpulse: (ix, iy, iz) => {
          rigidBodyRef.current?.applyImpulse({ x: ix, y: iy, z: iz }, true);
        },
        getPosition: () => {
          const t = rigidBodyRef.current?.translation();
          return t ? { x: t.x, y: t.y, z: t.z } : { x: 0, y: 0, z: 0 };
        }
      };
      const store = usePoBallStore.getState();
      store.registerHandle(ball.id, handle);
      return () => store.registerHandle(ball.id, null);
    }, [ball.id]);

    // Anti-Gravity Physics Limiter:
    // When swiping globally, maximum force throws can still cause the ball to vault or bounce 
    // off the lane edge due to the sudden impulse and ramp collision.
    // This actively clamps any positive Y velocity to keep it firmly planted on the surface.
    // We also cap the Z velocity to prevent the ball from breaking through the back wall.
    useFrame(() => {
      const rb = rigidBodyRef.current;
      if (!rb) return;

      const v = rb.linvel();
      let modified = false;
      let newY = v.y;
      let newZ = v.z;

      // If the ball is moving upwards faster than a tiny bump threshold, kill its upward momentum.
      if (v.y > 0.2) {
        newY = 0.2;
        modified = true;
      }

      // Absolute speed limit down the ramp to prevent tunneling/disappearing
      if (v.z < -8.0) {
        newZ = -8.0;
        modified = true;
      }

      if (modified) {
        rb.setLinvel({ x: v.x, y: newY, z: newZ }, true);
      }
    });

    return (
      <RigidBody
        key={troughKey}
        ref={rigidBodyRef}
        type="dynamic"
        ccd={true}
        colliders={false}
        restitution={0.05}
        friction={0.7}
        linearDamping={0.4}
        angularDamping={0.5}
        position={[ball.positionX, ball.positionY, 0]}
        userData={{ ballId: ball.id, laneId: ball.laneId }}
      >
        <BallCollider args={[BALL_RADIUS]} mass={0.01} />
        {/* White skeeball */}
        <mesh castShadow>
          <sphereGeometry args={[BALL_RADIUS, 16, 16]} />
          <meshStandardMaterial
            color="#ffffff"
            roughness={0.5}
            metalness={0.05}
          />
        </mesh>
      </RigidBody>
    );
  }
);
