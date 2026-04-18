/**
 * usePoSlingshotInput.ts — Slingshot pull-back input mode.
 *
 * Mechanic:
 *  onPointerDown  — record anchor point (where finger presses)
 *  onPointerMove  — compute pull vector from anchor; clamp max pull distance
 *  onPointerUp    — fire ball with impulse = pull vector reversed (opposite direction)
 *                   Force proportional to pull distance.
 *
 * Visual feedback:
 *  Returns `slingshotState` with anchor + pull info so the HUD can draw
 *  a rubber band / arrow overlay.
 *
 * Impulse calibration:
 *  K_SLINGSHOT: pixels of pull → world-unit impulse.
 *  Max pull = 200px → max impulse ≈ 1.3 (same cap as swipe mode IMPULSE_MAX).
 */

import { useRef, useState, useCallback } from 'react';
import type * as React from 'react';
import { usePoBallStore } from '../store/usePoBallStore';
import { poToMph } from '../utils/PoMphConverter';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const K_SLINGSHOT = 0.013;    // pixels of pull → impulse magnitude (Doubled)
const MAX_PULL_PX = 200;       // clamp pull distance
const IMPULSE_MAX = 2.6;       // (Doubled)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlingshotState {
    active: boolean;
    anchorX: number;
    anchorY: number;
    pullX: number;  // current delta from anchor (pixels)
    pullY: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePoSlingshotInput() {
    const [isAiming, setIsAiming] = useState(false);
    const [slingshotState, setSlingshotState] = useState<SlingshotState>({
        active: false, anchorX: 0, anchorY: 0, pullX: 0, pullY: 0,
    });

    const anchorRef = useRef<{ x: number; y: number } | null>(null);

    const { canLaunch } = usePoBallStore.getState();

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        if (!canLaunch(1)) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        anchorRef.current = { x: e.clientX, y: e.clientY };
        setIsAiming(true);
        setSlingshotState({
            active: true,
            anchorX: e.clientX,
            anchorY: e.clientY,
            pullX: 0,
            pullY: 0,
        });
    }, [canLaunch]);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        if (!anchorRef.current) return;
        const rawDx = e.clientX - anchorRef.current.x;
        const rawDy = e.clientY - anchorRef.current.y;

        // Clamp pull magnitude
        const dist = Math.sqrt(rawDx * rawDx + rawDy * rawDy);
        const clampedDist = Math.min(dist, MAX_PULL_PX);
        const scale = dist > 0 ? clampedDist / dist : 0;

        setSlingshotState(s => ({
            ...s,
            pullX: rawDx * scale,
            pullY: rawDy * scale,
        }));
    }, []);

    const onPointerUp = useCallback((_e: React.PointerEvent) => {
        if (!anchorRef.current || !isAiming) return;

        const { pullY } = slingshotState;

        // Slingshot fires in the OPPOSITE direction of the pull.
        // Pull DOWN (positive pullY) → fire UP the ramp (negative Z).
        // The main launch axis is Z (up the ramp).
        // pullY > 0 means pull toward player → -pullY becomes negative → fires -Z (up ramp).
        const rawIZ = -pullY * K_SLINGSHOT;

        // Disabled lateral/X impulse. Naturally pulling down-right was causing 
        // the ball to shoot left. Now it shoots perfectly straight.
        const rawIX = 0;
        const iy = 0.05; // small lift to clear trough lip

        // Ensure minimum forward roll
        let iz = rawIZ;
        if (iz > -0.4) iz = -0.4;

        // Clamp magnitude
        const rawMag = Math.sqrt(rawIX * rawIX + iy * iy + iz * iz);
        const clampScale = rawMag > IMPULSE_MAX ? IMPULSE_MAX / rawMag : 1;

        const finalIX = rawIX * clampScale;
        const finalIY = iy * clampScale;
        const finalIZ = iz * clampScale;
        const finalMag = Math.sqrt(finalIX * finalIX + finalIY * finalIY + finalIZ * finalIZ);

        // Pick any available InTrough ball
        const store = usePoBallStore.getState();
        if (!store.canLaunch(1)) {
            anchorRef.current = null;
            setIsAiming(false);
            setSlingshotState(s => ({ ...s, active: false }));
            return;
        }

        const mph = poToMph(finalMag);
        store.launchBallFromLane(1, { ix: finalIX, iy: finalIY, iz: finalIZ }, Math.max(0, mph));

        anchorRef.current = null;
        setIsAiming(false);
        setSlingshotState({ active: false, anchorX: 0, anchorY: 0, pullX: 0, pullY: 0 });
    }, [isAiming, slingshotState]);

    const onPointerLeave = useCallback((_e: React.PointerEvent) => {
        anchorRef.current = null;
        setIsAiming(false);
        setSlingshotState(s => ({ ...s, active: false }));
    }, []);

    const handlers = { onPointerDown, onPointerMove, onPointerUp, onPointerLeave };
    return { handlers, isAiming, slingshotState };
}
