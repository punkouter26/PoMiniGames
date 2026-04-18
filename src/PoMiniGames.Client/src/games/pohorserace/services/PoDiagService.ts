/**
 * PoDiagService.ts — GoF Strategy pattern: captures a PoDiagSnapshot
 * from live Zustand store state.
 * Annotation: // GoF Strategy — snapshot strategy reads Zustand getState() directly
 *   without subscribing to React state, satisfying the offline + transient pattern.
 *
 * PII masking: poSessionId and poUserId are masked with PoMaskString before the
 * snapshot object leaves this service (FR-030). Raw values MUST NOT appear in JSX.
 *
 * FPS: calculated from performance.now() delta between captureSnapshot() calls.
 * Geometry count: set each frame by RendererStatsSyncer inside PoScene (T071).
 */

import type { PoDiagSnapshot } from '../types/po-types';
import { poMaskString } from '../utils/PoMaskString';
import { PoLogger } from '../utils/PoLogger';
import { usePoRaceStore } from '../store/usePoRaceStore';
import { usePoLaneStore } from '../store/usePoLaneStore';

// GoF Strategy — snapshot strategy reads Zustand getState() directly.

// Stable session id for this browser session (not persisted)
const PO_SESSION_ID = `P${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

// Module-level state for renderer stats — updated by RendererStatsSyncer in PoScene (T071).
let _poTriangles = 0;
let _lastFrameTime = performance.now();
let _fps = 0;

class PoDiagServiceImpl {
  /**
   * Called each frame by RendererStatsSyncer in PoScene.tsx (T071).
   * Stores triangle count and frames-per-second estimate without touching React state.
   */
  setRendererStats(triangles: number): void {
    const now = performance.now();
    const delta = now - _lastFrameTime;
    // Smooth FPS over consecutive frame reports
    if (delta > 0) {
      _fps = Math.round((1000 / delta) * 10) / 10;
    }
    _lastFrameTime = now;
    _poTriangles = triangles;
  }

  /**
   * Captures a point-in-time telemetry snapshot.
   * Reads Zustand store state transiently (no subscribe — no React re-render).
   * All PII fields masked before the object is returned (FR-030).
   */
  captureSnapshot(): PoDiagSnapshot {
    // Read Zustand state transient values without triggering re-renders
    const { phase, elapsedSeconds } = usePoRaceStore.getState();
    const { lanes } = usePoLaneStore.getState();

    const now = new Date().toISOString();

    const snapshot: PoDiagSnapshot = {
      poCapturedAt: now,
      poFps: _fps,
      poGeometryCount: _poTriangles,
      poHorsePositions: lanes.map(l => ({
        laneId: l.id,
        positionInches: l.positionInches,
      })),
      // FR-030: mask PII before returning — raw values MUST NOT appear in JSX
      poSessionId: poMaskString(PO_SESSION_ID),
      poUserId: null, // no auth in v1.0
      poRacePhase: phase,
      poElapsedSeconds: elapsedSeconds,
    };

    PoLogger.log({
      timestamp: now,
      level: 'debug',
      service: 'PoDiagService',
      action: 'captureSnapshot',
      status: 'ok',
      detail: { phase, elapsedSeconds, fps: _fps },
    });

    return snapshot;
  }
}

/** Exported singleton. */
export const PoDiagService = new PoDiagServiceImpl();
