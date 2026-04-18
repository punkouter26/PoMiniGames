/**
 * PoLedDisplay.tsx — Seven-segment-style LED clock display.
 *
 * T057 [US3]: filament-flicker animation triggered on value change.
 *   Opacity keyframe sequence [1, 0.15, 0.7, 0.3, 1.0] over 180ms total.
 *   Implemented via useSpring + useFrame imperative fillOpacity update.
 *
 * T063 [US3]: layers.enable(1) on Text mesh for SelectiveBloom eligibility.
 *
 * FR-020: amber/orange LED colour (#ff8c00) with slight emissive glow.
 */

import type { JSX } from 'react';
import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { useSpring } from '@react-spring/three';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LED_COLOR = '#ff8c00';      // amber LED
const LED_EMISSIVE = '#ff6600';   // emissive tint for glow
const FONT_SIZE = 0.28;

// ---------------------------------------------------------------------------
// PoLedDisplay
// ---------------------------------------------------------------------------

interface PoLedDisplayProps {
  /** Text to display — digits, colon-separated time, or "--". */
  value: string;
  /** World-space X position. */
  x: number;
  /** World-space Y position. */
  y: number;
  /** World-space Z position. */
  z?: number;
}

export function PoLedDisplay({ value, x, y, z = 0.1 }: PoLedDisplayProps): JSX.Element {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textRef = useRef<any>(null);

  // T057: filament-flicker spring — keyframe sequence over 180ms on value change.
  const [{ opacity }, api] = useSpring(() => ({ opacity: 1 }));

  useEffect(() => {
    api.start({
      to: [
        { opacity: 0.15, config: { duration: 36 } },
        { opacity: 0.70, config: { duration: 36 } },
        { opacity: 0.30, config: { duration: 36 } },
        { opacity: 1.00, config: { duration: 72 } },
      ],
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // T057: Apply spring opacity to tres Text each frame (avoids React re-renders).
  useFrame(() => {
    if (textRef.current) {
      textRef.current.fillOpacity = opacity.get();
    }
  });

  // T063: Enable SelectiveBloom layer on mount.
  useEffect(() => {
    if (textRef.current) {
      textRef.current.layers.enable(1);
    }
  }, []);

  return (
    <Text
      ref={textRef}
      position={[x, y, z]}
      fontSize={FONT_SIZE}
      color={LED_COLOR}
      anchorX="center"
      anchorY="middle"
      // Monospace-adjacent rendering for digit stability
      letterSpacing={0.05}
      outlineColor={LED_EMISSIVE}
      outlineOpacity={0.3}
      outlineWidth={0.008}
    >
      {value}
    </Text>
  );
}
