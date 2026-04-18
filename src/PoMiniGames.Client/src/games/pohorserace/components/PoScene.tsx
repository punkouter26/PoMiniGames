/**
 * PoScene.tsx — Root R3F Canvas with physics, post-processing, and guards.
 *
 * Architecture (data-model.md, plan.md):
 *  - Single <Canvas> entry point for all 3D content.
 *  - Accepts `children` so PoMidway can mount game components inside the canvas.
 *  - <Physics> with 10° inclined gravity (T053).
 *  - <EffectComposer> + <SelectiveBloom> for emissive mesh glow (T056).
 *  - <PoOrientationGuard> blocks landscape use.
 *  - Offline pill (C2 fix, T027b) — always visible, non-intrusive, bottom-right.
 *  - T062: WinnerBellTrigger subscribes to phase → 'Finished' inside Canvas.
 *  - T064: onPointerDown on Canvas initialises PoAudioService (Web Audio policy).
 *
 * COOP/COEP headers (required for Rapier SharedArrayBuffer) are set in
 * vite.config.ts server.headers / preview.headers — NOT in this file.
 */

import type { JSX, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Physics } from '@react-three/rapier';
import { PoOrientationGuard } from './PoOrientationGuard';
import { usePoConnectivity } from '../hooks/usePoConnectivity';
import { usePoSwipeInput } from '../hooks/usePoSwipeInput';
import { usePoSlingshotInput } from '../hooks/usePoSlingshotInput';
import { usePoInputModeStore } from '../store/usePoInputModeStore';
import { usePoRaceStore } from '../store/usePoRaceStore';
import { usePoGameModeStore } from '../store/usePoGameModeStore';
import { poAudioService } from '../services/PoAudioService';
import { PoDiagService } from '../services/PoDiagService';

interface PoSceneProps {
  /** Non-physics visuals that should always render even if Rapier is still initialising. */
  staticChildren?: ReactNode;
  /** Physics-bound scene content (RigidBody/Collider components). */
  physicsChildren?: ReactNode;
}

// ---------------------------------------------------------------------------
// T062: Winner's bell trigger — render-less, must live inside <Canvas>.
// GoF Observer: subscribes to Zustand race phase transitions.
// ---------------------------------------------------------------------------

function WinnerBellTrigger(): null {
  const phaseRef = useRef(usePoRaceStore.getState().phase);

  useEffect(() => {
    // GoF Observer — subscribe to phase transitions without React re-render.
    const unsub = usePoRaceStore.subscribe(state => {
      const prev = phaseRef.current;
      phaseRef.current = state.phase;
      if (prev !== 'Finished' && state.phase === 'Finished') {
        poAudioService.playWinnerBell();
      }
    });
    return unsub;
  }, []);

  return null;
}

// ---------------------------------------------------------------------------
// T071: Renderer stats syncer — forwards gl.info.render.triangles to
// PoDiagService every frame using module-level write (no React state).
// ---------------------------------------------------------------------------

function RendererStatsSyncer(): null {
  const gl = useThree(state => state.gl);
  useFrame(() => {
    PoDiagService.setRendererStats(gl.info.render.triangles);
  });
  return null;
}

// ---------------------------------------------------------------------------
// InputPlane — conditionally uses swipe or slingshot handlers
// (must live inside Canvas so hooks can call usePoSwipeInput/usePoSlingshotInput)
// ---------------------------------------------------------------------------

function InputPlane(): JSX.Element {
  const inputMode = usePoInputModeStore(s => s.inputMode);
  const gameMode = usePoGameModeStore(s => s.gameMode);
  const swipe = usePoSwipeInput();
  const slingshot = usePoSlingshotInput();
  const handlers = gameMode === 'demo'
    ? {}
    : (inputMode === 'slingshot' ? slingshot.handlers : swipe.handlers);

  return (
    <mesh position={[0, 4.8, 10]} {...handlers}>
      <planeGeometry args={[100, 100]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} color="#ffffff" />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// PoScene
// ---------------------------------------------------------------------------

export function PoScene({ staticChildren, physicsChildren }: PoSceneProps): JSX.Element {
  const { mode } = usePoConnectivity();

  // T064: Initialise Web Audio on first user gesture (autoplay policy).
  const handlePointerDown = (): void => {
    poAudioService.init().catch(() => {/* no-op — init is idempotent */ });
  };

  return (
    <Canvas
      gl={{ antialias: true, alpha: true }}
      camera={{ fov: 50, near: 0.1, far: 1000, position: [0, 3.2, 16.5] }}
      style={{ width: '100%', height: '100%', background: 'transparent', position: 'absolute', inset: 0, zIndex: 1 }}
      onPointerDown={handlePointerDown}
    >
      {/* Ambient + key/fill lighting */}
      <ambientLight intensity={1.2} />
      <directionalLight position={[0, 8, 14]} intensity={1.4} castShadow />
      <directionalLight position={[-6, 2, 8]} intensity={0.6} />

      {/* Portrait-lock guard */}
      <PoOrientationGuard />

      {/* Input plane — swaps between Swipe and Slingshot based on HUD toggle */}
      <InputPlane />


      {/* T062: Winner's bell subscriber (render-less, inside Canvas context). */}
      <WinnerBellTrigger />

      {/* T071: Forward renderer triangle count to PoDiagService (module-level, no React state). */}
      <RendererStatsSyncer />

      {/* Static/non-physics visuals render outside Rapier so the scene is still
          visible in browsers where physics initialisation is delayed. */}
      {staticChildren}

      {/*
        T053: Physics provider with 20° inclined gravity.
        Y component: -9.81*cos(20°) ≈ -9.220  (downward normal to ramp surface)
        Z component: +9.81*sin(20°) ≈ +3.355  (toward player/trough = +Z rollback)
      */}
      <Physics gravity={[0, -9.81 * Math.cos(20 * Math.PI / 180), 9.81 * Math.sin(20 * Math.PI / 180)]}>
        {/* Flat dark grey ground plane */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.5, 0]} receiveShadow>
          <planeGeometry args={[40, 40]} />
          <meshStandardMaterial color="#222222" roughness={0.9} metalness={0.0} />
        </mesh>
        {physicsChildren}
      </Physics>

      {/* T056: Bloom removed — @react-three/postprocessing v3 EffectComposer
          crashes with null readBuffer on R3F v9. Emissive materials retain
          natural glow. Re-enable when upgrading postprocessing to v4+. */}

      {/* Offline Mode pill — Constitution Principle II MUST (C2 fix, T027b) */}
      <Html
        position={[0, 0, 0]}
        style={{ pointerEvents: 'none' }}
        zIndexRange={[100, 100]}
        fullscreen
      >
        <div
          className="po-offline-pill"
          data-mode={mode}
          aria-label="Offline Mode indicator"
        >
          ● Offline Mode
        </div>
      </Html>
    </Canvas>
  );
}
