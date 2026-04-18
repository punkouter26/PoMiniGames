/**
 * PoSummaryCard.tsx — Post-race summary overlay (FR-005).
 *
 * Rendered via @react-three/drei <Html> floating in 3D space.
 * Only visible when phase === 'Finished'.
 *
 * Displays:
 *  - Total Sprint Time (mm:ss)
 *  - Accuracy % (balls that scored / balls launched × 100, 1dp)
 *  - Avg Roll Speed mph (mean of sessionReleaseSpeedsMph, 1dp)
 *
 * Accuracy: in Phase 3 there are no real ball launches yet; the summary card
 * shows "--" when no balls have been launched. Phase 4 wires real ball data.
 */

import type { JSX } from 'react';
import { Html } from '@react-three/drei';
import { usePoRaceStore } from '../store/usePoRaceStore';
import { usePoLaneStore } from '../store/usePoLaneStore';
import { usePoBallStore } from '../store/usePoBallStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function calcAvgSpeed(speeds: number[]): string {
  if (speeds.length === 0) return '--';
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  return `${mean.toFixed(1)} mph`;
}

// ---------------------------------------------------------------------------
// PoSummaryCard
// ---------------------------------------------------------------------------

export function PoSummaryCard(): JSX.Element | null {
  const phase = usePoRaceStore(s => s.phase);
  const elapsedSeconds = usePoRaceStore(s => s.elapsedSeconds);
  const winnerLaneId = usePoRaceStore(s => s.winnerLaneId);

  const lanes = usePoLaneStore(s => s.lanes);
  const sessionReleaseSpeedsMph = usePoBallStore(s => s.sessionReleaseSpeedsMph);

  if (phase !== 'Finished') return null;

  const playerLane = lanes.find(l => l.isPlayerControlled);
  const winnerLane = winnerLaneId !== null ? lanes.find(l => l.id === winnerLaneId) : null;

  // Accuracy: each scoring hole visit = 1 ball launched (proxy until Phase 4 tracks directly)
  // sessionReleaseSpeedsMph.length = total balls launched this session
  const ballsLaunched = sessionReleaseSpeedsMph.length;
  const accuracyStr = ballsLaunched === 0
    ? '--'
    : `${(((playerLane?.score ?? 0) / Math.max(ballsLaunched, 1)) * 100).toFixed(1)}%`;

  return (
    <Html
      position={[0, 4.5, 0.5]}
      center
      zIndexRange={[150, 150]}
      style={{ pointerEvents: 'none' }}
    >
      <div
        style={{
          background: 'rgba(0,0,0,0.85)',
          border: '2px solid #ff8c00',
          borderRadius: '12px',
          padding: '1.5rem 2.5rem',
          color: '#fff',
          fontFamily: 'monospace',
          minWidth: '260px',
          textAlign: 'center',
          userSelect: 'none',
        }}
      >
        <h2 style={{ margin: '0 0 0.8rem', color: '#ff8c00', fontSize: '1.1rem', letterSpacing: '0.1em' }}>
          🏆 RACE COMPLETE
        </h2>

        {winnerLane && (
          <p style={{ margin: '0 0 0.6rem', fontSize: '0.85rem', opacity: 0.8 }}>
            Winner: Lane {winnerLane.id} ({winnerLane.color.replace('Po', '')})
          </p>
        )}

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.95rem' }}>
          <tbody>
            <tr>
              <td style={{ padding: '0.3rem 0', opacity: 0.7, textAlign: 'left' }}>Sprint Time</td>
              <td style={{ padding: '0.3rem 0', color: '#ff8c00', textAlign: 'right', fontWeight: 'bold' }}>
                {formatTime(elapsedSeconds)}
              </td>
            </tr>
            <tr>
              <td style={{ padding: '0.3rem 0', opacity: 0.7, textAlign: 'left' }}>Accuracy</td>
              <td style={{ padding: '0.3rem 0', color: '#ff8c00', textAlign: 'right', fontWeight: 'bold' }}>
                {accuracyStr}
              </td>
            </tr>
            <tr>
              <td style={{ padding: '0.3rem 0', opacity: 0.7, textAlign: 'left' }}>Avg Roll Speed</td>
              <td style={{ padding: '0.3rem 0', color: '#ff8c00', textAlign: 'right', fontWeight: 'bold' }}>
                {calcAvgSpeed(sessionReleaseSpeedsMph)}
              </td>
            </tr>
          </tbody>
        </table>

        <p style={{ margin: '1rem 0 0', fontSize: '0.75rem', opacity: 0.5 }}>
          Press RESET to play again
        </p>
      </div>
    </Html>
  );
}
