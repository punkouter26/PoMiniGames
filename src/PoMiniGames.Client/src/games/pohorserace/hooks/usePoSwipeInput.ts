/**
 * usePoSwipeInput.ts — Swipe-to-impulse input hook with weighted smoothing.
 * T046 [US2]
 *
 * Algorithm:
 *  onPointerDown  — record start position + timestamp
 *  onPointerMove  — blend factor 0.25 for momentum lag (weighted smoothing)
 *  onPointerUp    — compute impulse vector, record release speed, call applyImpulse
 *
 * Impulse calibration (T048 FR-009):
 *  kScale converts pointer-px delta to Rapier world-unit impulse magnitude.
 *  Min detectable swipe ≈ 8 mph, max ≈ 28 mph.
 *  Z (up the ramp) is the primary impulse axis.
 *
 * T049: checks canLaunch() before allowing aiming.
 *
 * Returns { handlers, isAiming }
 */

import { useRef, useState, useCallback } from 'react';
import type * as React from 'react';
import { usePoBallStore } from '../store/usePoBallStore';
import { poToMph } from '../utils/PoMphConverter';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Pixels → world-unit impulse scale. Tuned so ~100 px ≈ 0.9 world impulse. */
const K_SCALE = 0.009;

/** Weighted smoothing blend factor (0=no smooth, 1=instant). */
const BLEND = 0.25;

/** Maximum impulse magnitude cap (prevents absurd overshoots). Lowered to keep balls grounded. */
const IMPULSE_MAX = 1.3;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UsePoSwipeInputOptions { }

export interface PoSwipeHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerLeave: (e: React.PointerEvent) => void;
}

export function usePoSwipeInput(_options?: UsePoSwipeInputOptions) {
  const [isAiming, setIsAiming] = useState(false);

  const startRef = useRef<{ x: number; y: number; t: number } | null>(null);
  // Smoothed delta accumulator
  const smoothRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  const { canLaunch } = usePoBallStore.getState();

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // T049: block if no ball is in trough
    if (!canLaunch(1)) return;

    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    smoothRef.current = { dx: 0, dy: 0 };
    setIsAiming(true);
  }, [canLaunch]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!startRef.current) return;

    const rawDx = e.clientX - startRef.current.x;
    const rawDy = e.clientY - startRef.current.y; // positive = toward player

    // Weighted smoothing: blend toward raw delta (FR-009 momentum lag)
    smoothRef.current.dx += (rawDx - smoothRef.current.dx) * BLEND;
    smoothRef.current.dy += (rawDy - smoothRef.current.dy) * BLEND;
  }, []);

  const onPointerUp = useCallback((_e: React.PointerEvent) => {
    if (!startRef.current || !isAiming) return;

    const { dx, dy } = smoothRef.current;

    // Convert 2D screen delta to 3D impulse.
    // We want a FLICK UP mechanic:
    // Swipe UP screen → dy is negative.
    // Up the ramp is -Z.
    let iz = dy * K_SCALE;

    // Ensure ball always rolls forward min amount, even if tapped or swiped down
    if (iz > -0.5) iz = -0.5;

    // Drastically attenuate lateral swipe so we don't hit neighboring balls in the trough (billiards effect)
    const ix = dx * K_SCALE * 0.15;

    // Small upward component just to clear the trough lip.
    const iy = 0.05;

    // Clamp magnitude
    const rawMag = Math.sqrt(ix * ix + iy * iy + iz * iz);
    const scale = rawMag > IMPULSE_MAX ? IMPULSE_MAX / rawMag : 1;

    const finalIX = ix * scale;
    const finalIY = iy * scale;
    const finalIZ = iz * scale;
    const finalMag = Math.sqrt(finalIX * finalIX + finalIY * finalIY + finalIZ * finalIZ);

    // Pick ANY available InTrough ball (not always the first)
    const mph = poToMph(finalMag);
    const store = usePoBallStore.getState();
    store.launchBallFromLane(1, { ix: finalIX, iy: finalIY, iz: finalIZ }, Math.max(0, mph));

    startRef.current = null;
    setIsAiming(false);
  }, [isAiming]);

  const onPointerLeave = useCallback((_e: React.PointerEvent) => {
    startRef.current = null;
    setIsAiming(false);
  }, []);

  const handlers: PoSwipeHandlers = { onPointerDown, onPointerMove, onPointerUp, onPointerLeave };

  return { handlers, isAiming };
}
