/**
 * PoTargetTriangle.tsx — The scoring board with 5 PoScoringHole instances.
 * T044 [US2]
 *
 * Layout (FR-015): pyramid with apex pointing toward backdrop (-Z in ramp-local):
 *    Row 3 (Apex):   1 hole — 3 pts  (topmost, near scoring-zone far edge)
 *    Row 2 (Middle): 2 holes — 2 pts each
 *    Row 1 (Base):   2 holes — 1 pt  (nearest player end of scoring zone)
 *
 * NOTE: The real machine has 10 holes (4-3-2-1) shown in PoLaneRamp decoratively.
 *       This component controls the PHYSICS scoring holes (5 holes, per spec FR-015).
 *       It is mounted inside the ramp-local rotated group so it sits on the surface.
 *
 * onScore wiring (T052):
 *   → usePoLaneStore.addScore(1, points)    — advances player horse
 *   → usePoBallStore.setPhase(ballId, 'Scoring') — removes ball, starts return timer
 *   → usePoRaceStore.finishRace(1)           — fired by setGoldGlow when 60" reached
 */

import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import type { PoScoringHole as PoScoringHoleType, PoHoleRow } from '../types/po-types';
import { PoScoringHole } from './PoScoringHole';
import { PoParticlePoof } from './PoParticlePoof';
import { usePoLaneStore } from '../store/usePoLaneStore';
import { usePoBallStore } from '../store/usePoBallStore';
import { poAudioService } from '../services/PoAudioService';
import { PO_HOLE_POSITIONS } from './PoLaneRamp';
import { usePoGameModeStore } from '../store/usePoGameModeStore';

// ---------------------------------------------------------------------------
// Hole layout in ramp-local space (Y = surface level, set by PoScoringHole)
// ---------------------------------------------------------------------------

const HOLE_DEFS_DEMO: Array<{ id: number; row: PoHoleRow; pointValue: 1 | 2 | 3 | 5; lx: number; lz: number }> = [
  ...PO_HOLE_POSITIONS.slice(0, 4).map((h, i) => ({ id: i + 1, row: 'Base' as const, pointValue: h.points, lx: h.lx, lz: h.lz })),
  ...PO_HOLE_POSITIONS.slice(4, 7).map((h, i) => ({ id: i + 5, row: 'Row3' as const, pointValue: h.points, lx: h.lx, lz: h.lz })),
  ...PO_HOLE_POSITIONS.slice(7, 9).map((h, i) => ({ id: i + 8, row: 'Row2' as const, pointValue: h.points, lx: h.lx, lz: h.lz })),
  { id: 10, row: 'Apex', pointValue: 5, lx: PO_HOLE_POSITIONS[9]!.lx, lz: PO_HOLE_POSITIONS[9]!.lz },
];



// ---------------------------------------------------------------------------
// Poof event type (for local state)
// ---------------------------------------------------------------------------

interface PoofEvent {
  key: string;
  lx: number;
  lz: number;
}

// ---------------------------------------------------------------------------
// PoTargetTriangle
// ---------------------------------------------------------------------------

interface PoTargetTriangleProps {
  laneId: number;
}

export function PoTargetTriangle({ laneId }: PoTargetTriangleProps): JSX.Element {
  const gameMode = usePoGameModeStore(s => s.gameMode);
  const addScore = usePoLaneStore(s => s.addScore);
  const setPhase = usePoBallStore(s => s.setPhase);
  const [poofs, setPoofs] = useState<PoofEvent[]>([]);

  // All 10 holes are now physical scoring holes with raised 3D rims
  const holeDefs = HOLE_DEFS_DEMO;

  // Build PoScoringHole data objects from defs
  const holes = useMemo<PoScoringHoleType[]>(() =>
    holeDefs.map(d => ({
      id: d.id,
      row: d.row,
      pointValue: d.pointValue,
      rimCollisionActive: false,
      sensorTriggered: false,
    })),
    [holeDefs]
  );

  const handleScore = (holeId: number, points: number, ballId: number | null, scoredLaneId: number) => {
    // Math reality: 3 balls taking 6s to return means max ~7-9 balls scored per 15s.
    // To finish a 100-point race purely on these rare sinks, the multiplier must be large.
    const finalPoints = gameMode === 'demo' ? points * 25 : points;
    addScore(scoredLaneId, finalPoints);

    if (ballId !== null) {
      setPhase(ballId, 'Scoring');
    }

    // Audio
    poAudioService.playRimClack(points * 3);

    // Spawn gold particle poof at hole position precisely when ball hits the deep sensor
    const holeDef = holeDefs.find(h => h.id === holeId);
    if (holeDef) {
      const key = `poof-${holeId}-${Date.now()}`;
      setPoofs(prev => [...prev, { key, lx: holeDef.lx, lz: holeDef.lz }]);
    }
  };

  const removePoof = (key: string) => {
    setPoofs(prev => prev.filter(p => p.key !== key));
  };

  return (
    <group name="PoTargetTriangle">
      {holes.map((hole, i) => (
        <PoScoringHole
          key={hole.id}
          hole={hole}
          lx={holeDefs[i]!.lx}
          lz={holeDefs[i]!.lz}
          laneId={laneId}
          onScore={handleScore}
        />
      ))}

      {/* Gold particle poofs — spawned at scoring hole positions */}
      {poofs.map(p => (
        <PoParticlePoof
          key={p.key}
          x={p.lx}
          y={0.1}
          z={p.lz}
          onComplete={() => removePoof(p.key)}
        />
      ))}
    </group>
  );
}
