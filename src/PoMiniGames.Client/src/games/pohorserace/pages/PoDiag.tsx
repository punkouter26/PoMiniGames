/**
 * PoDiag.tsx — Diagnostic telemetry page (/diag route).
 *
 * T070: Full implementation.
 *   - Polls PoDiagService.captureSnapshot() at 10 Hz (100 ms interval).
 *   - Renders live JSON snapshot in a monospace <pre> block.
 *   - Provides a Back link to the main Midway ('/') route.
 *
 * T068 (Zustand persistence): Zustand stores are module-level singletons —
 * navigation does NOT clear store state. The race phase, positions, and ball
 * data remain live while the user views this page, which is why the snapshot
 * updates reflect any ongoing simulation.
 *
 * No network requests are made here: all data comes from in-memory Zustand
 * store, satisfying FR-031 + FR-032 (offline-first).
 */

import type { JSX } from 'react';
import { useState, useEffect } from 'react';
import type { PoDiagSnapshot } from '../types/po-types';
import { PoDiagService } from '../services/PoDiagService';

// Polling interval in milliseconds (10 Hz as per spec SC-007: < 500 ms latency)
const POLL_INTERVAL_MS = 100;

interface PoDiagProps {
  onBack?: () => void;
}

export function PoDiag({ onBack }: PoDiagProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<PoDiagSnapshot | null>(null);

  useEffect(() => {
    // Capture immediately so the panel isn't blank on first render
    setSnapshot(PoDiagService.captureSnapshot());

    const intervalId = setInterval(() => {
      setSnapshot(PoDiagService.captureSnapshot());
    }, POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="po-diag-panel" aria-label="Diagnostic telemetry panel">
      <nav className="po-diag-nav">
        <button type="button" onClick={onBack} className="po-diag-back">← Back to Midway</button>
      </nav>
      <pre className="po-diag-json">
        {snapshot !== null
          ? JSON.stringify(snapshot, null, 2)
          : 'Loading telemetry…'}
      </pre>
    </div>
  );
}
