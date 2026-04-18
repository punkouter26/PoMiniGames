/**
 * PoHorseWall.tsx — Horizontal arcade backdrop showing all 8 race lanes.
 *
 * Layout (right-to-left race)
 * ---------------------------
 *  • 8 lanes are stacked as horizontal ROWS along the Y axis.
 *  • Horses start on the RIGHT (X = PO_HORSE_BASE_X = +10.0) and race LEFT.
 *  • At positionInches = 60 the horse reaches X = PO_HORSE_FINISH_X = −10.0.
 *  • Gold finish line = vertical bar at X = PO_HORSE_FINISH_X (left edge).
 *  • White start line = vertical bar at X = PO_HORSE_BASE_X  (right edge).
 *
 * Children per lane
 * ------------------
 *  • <PoHorse>      — animated 3-D figure (T028)
 *  • <PoLedDisplay> — race clock / countdown display (T029 + T039)
 *
 * LED logic (T039)
 * --------
 *  • countdownValue !== null   →  show the countdown digit  ("3", "2", "1")
 *  • phase === 'Racing'        →  show formatted elapsed time  "M:SS"
 *  • otherwise (Idle/Finished) →  show "--"
 */

import type { JSX } from 'react';
import { usePoRaceStore } from '../store/usePoRaceStore';
import { usePoLaneStore } from '../store/usePoLaneStore';
import { PoHorse, PO_HORSE_BASE_X, PO_HORSE_FINISH_X } from './PoHorse';
import { PoLedDisplay } from './PoLedDisplay';
import { RAMP_FAR_END_TOP_Y } from './PoLaneRamp';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/**
 * World-space Y positions for lanes 1–8 (index = laneId − 1).
 * Lanes stack top-to-bottom: lane 1 at +3.5, lane 8 at −3.5.
 */
export const PO_LANE_Y_POSITIONS: readonly number[] = [
  3.5, 2.5, 1.5, 0.5, -0.5, -1.5, -2.5, -3.5,
];

/**
 * Legacy X-position export kept for PoLaneRamp / PoMidway ramp compatibility.
 * The horse wall display now uses PO_LANE_Y_POSITIONS (row layout).
 */
export const PO_LANE_X_POSITIONS: readonly number[] = [
  -9.24, -6.60, -3.96, -1.32, 1.32, 3.96, 6.60, 9.24,
];

/** Width of the green backdrop (covers full track + padding). */
const WALL_W = 21.5;
/** Height of the green backdrop (covers all 8 lane rows + padding). */
const WALL_H = 9.0;

/**
 * Y offset applied to the whole PoHorseWall group so that the BOTTOM edge of
 * the backdrop plane sits exactly at the top of the ramp far end.
 * wallCenterY = RAMP_FAR_END_TOP_Y + WALL_H / 2
 */
export const WALL_OFFSET_Y = RAMP_FAR_END_TOP_Y + WALL_H / 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// PoHorseWall
// ---------------------------------------------------------------------------

export function PoHorseWall(): JSX.Element {
  const phase = usePoRaceStore(s => s.phase);
  const countdownValue = usePoRaceStore(s => s.countdownValue);
  const elapsedSeconds = usePoRaceStore(s => s.elapsedSeconds);
  const lanes = usePoLaneStore(s => s.lanes);

  const clockLabel: string = (() => {
    if (countdownValue !== null) return String(countdownValue);
    if (phase === 'Racing' || phase === 'Finished') return formatTime(elapsedSeconds);
    return '--';
  })();

  return (
    // Group is shifted up so its bottom edge aligns with the ramp far-end top surface.
    <group name="PoHorseWall" position={[0, WALL_OFFSET_Y, 0]}>
      {/* ── Backdrop felt plane (landscape) ─────────────────────────────── */}
      <mesh position={[0, 0, -0.3]} receiveShadow>
        <planeGeometry args={[WALL_W, WALL_H]} />
        <meshStandardMaterial color="#2d6a48" emissive="#1a3e2a" emissiveIntensity={0.6} roughness={0.9} metalness={0.0} />
      </mesh>

      {/* ── Finish line — gold bar at actual horse finish X ─────────────── */}
      <mesh position={[PO_HORSE_FINISH_X, 0, -0.25]}>
        <planeGeometry args={[0.1, WALL_H - 0.3]} />
        <meshStandardMaterial color="#ffd700" emissive="#ffd700" emissiveIntensity={1.2} />
      </mesh>

      {/* ── Start line — white bar at actual horse start X ──────────────── */}
      <mesh position={[PO_HORSE_BASE_X, 0, -0.25]}>
        <planeGeometry args={[0.07, WALL_H - 0.3]} />
        <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.6} />
      </mesh>


      {/* ── Lane rows + horses + LED displays ─────────────────────────────── */}
      {lanes.map((lane, i) => {
        const y = PO_LANE_Y_POSITIONS[i] ?? 0;
        return (
          <group key={lane.id} name={`lane-${lane.id}`}>
            {/* Horizontal lane separator (drawn at the bottom edge of each row) */}
            <mesh position={[0, y - 0.5, -0.22]}>
              <planeGeometry args={[WALL_W - 0.4, 0.02]} />
              <meshStandardMaterial color="#1e5233" roughness={1} />
            </mesh>

            {/* Animated horse — X is spring-animated right→left */}
            <PoHorse lane={lane} y={y} />

            {/* LED clock display — right side near start line */}
            <PoLedDisplay
              value={clockLabel}
              x={WALL_W / 2 - 0.35 + 0.7}
              y={y}
              z={-0.15}
            />
          </group>
        );
      })}

      {/* ── Ambient fill lights for the wall ──────────────────────────────── */}
      <pointLight position={[0, 0, 3]} intensity={2.5} color="#ffe4b0" />
      <pointLight position={[0, 0, -1]} intensity={1.5} color="#ffffff" />
    </group>
  );
}
