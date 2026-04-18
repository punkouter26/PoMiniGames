/**
 * PoDiegeticButton.tsx — 3-D in-world button mesh with depress animation.
 *
 * RESET behaviour (FR-007)
 * ─────────────────────────
 *   Idle        → startCountdown()
 *   Countdown   → no-op (guard — do not double-press)
 *   Racing      → resetRace() + resetAllLanes() + resetAll()
 *   Finished    → resetRace() + resetAllLanes() + resetAll()
 *
 * DIAG behaviour
 * ──────────────
 *   Any phase → navigate('/diag')
 *
 * The button depresses (translates –Z by 0.12 world units) on press then
 * springs back, using react-spring for the animation.
 */

import type { JSX } from 'react';
import { useCallback } from 'react';
import { Text } from '@react-three/drei';
import { useSpring, animated } from '@react-spring/three';
import type { Vector3 } from '@react-three/fiber';

import { usePoRaceStore }  from '../store/usePoRaceStore';
import { usePoLaneStore }  from '../store/usePoLaneStore';
import { usePoBallStore }  from '../store/usePoBallStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PoDiegeticButtonLabel = 'RESET' | 'DIAG';

interface PoDiegeticButtonProps {
  label: PoDiegeticButtonLabel;
  position?: Vector3;
  onDiag?: () => void;
}

// ---------------------------------------------------------------------------
// PoDiegeticButton
// ---------------------------------------------------------------------------

const BTN_W = 0.9;
const BTN_H = 0.4;
const BTN_D = 0.18;

const DEPRESS_Z    = -0.12;
const SPRING_CFG   = { mass: 1, tension: 400, friction: 18 };
const LABEL_COLORS: Record<PoDiegeticButtonLabel, string> = {
  RESET: '#ef4444',
  DIAG:  '#3b82f6',
};

export function PoDiegeticButton({ label, position = [0, 0, 0], onDiag }: PoDiegeticButtonProps): JSX.Element {
  // Store actions — use individual selectors (not object selector) to avoid
  // returning a new object reference every render, which causes infinite loops.
  const phase          = usePoRaceStore(s => s.phase);
  const startCountdown = usePoRaceStore(s => s.startCountdown);
  const resetRace      = usePoRaceStore(s => s.resetRace);
  const resetAllLanes = usePoLaneStore(s => s.resetAllLanes);
  const resetAll      = usePoBallStore(s => s.resetAll);

  // Depress animation spring.
  const [{ depressZ }, api] = useSpring(() => ({
    depressZ: 0,
    config: SPRING_CFG,
  }));

  const handlePress = useCallback(() => {
    // Animate depress + spring back.
    api.start({ depressZ: DEPRESS_Z });
    setTimeout(() => api.start({ depressZ: 0 }), 120);

    if (label === 'DIAG') {
      onDiag?.();
      return;
    }

    // RESET logic.
    switch (phase) {
      case 'Idle':
        startCountdown();
        break;
      case 'Countdown':
        // No-op — guard against double-press during countdown.
        break;
      case 'Racing':
      case 'Finished':
        resetRace();
        resetAllLanes();
        resetAll();
        break;
    }
  }, [label, phase, onDiag, api, startCountdown, resetRace, resetAllLanes, resetAll]);

  const color = LABEL_COLORS[label];

  return (
    <animated.group position={position as [number, number, number]} position-z={depressZ}>
      {/* Button body */}
      <mesh onPointerDown={handlePress} castShadow>
        <boxGeometry args={[BTN_W, BTN_H, BTN_D]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.2} />
      </mesh>

      {/* Face label */}
      <Text
        position={[0, 0, BTN_D / 2 + 0.01]}
        fontSize={0.14}
        color="#ffffff"
        anchorX="center"
        anchorY="middle"
        font={undefined}
      >
        {label}
      </Text>
    </animated.group>
  );
}
