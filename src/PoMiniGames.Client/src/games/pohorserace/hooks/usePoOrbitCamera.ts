/**
 * usePoOrbitCamera.ts — Orbit camera spring animation for the win sequence.
 *
 * Race cam (default): fixed position [0, 0, 12] looking at [0, 0, 0].
 * Orbit cam (phase='Finished'): camera moves to [-3.5, winnerY+1.5, 5]
 *   looking at [-3.0, winnerY, 0] (zooms into winner at finish line).
 *
 * Returns { isOrbiting, springs } consumed by PoCameraRig which applies
 * spring values to the R3F camera each frame via useFrame.
 *
 * The winner horse Y row position is derived from lane ID → PO_LANE_Y_POSITIONS.
 */

import { useEffect } from 'react';
import { useSpring } from '@react-spring/three';
import { usePoRaceStore } from '../store/usePoRaceStore';
import { PO_LANE_Y_POSITIONS, WALL_OFFSET_Y } from '../components/PoHorseWall';
import { PO_HORSE_FINISH_X } from '../components/PoHorse';

// ---------------------------------------------------------------------------
// Camera anchors
// ---------------------------------------------------------------------------

const RACE_CAM_POS    = [0, 3.2, 16.5] as [number, number, number];
const RACE_CAM_TARGET = [0, 1.4, 0] as [number, number, number];

/** Quadratic Slow-In/Out easing. */
const slowInOut = (t: number): number =>
  t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

const ORBIT_CONFIG = { mass: 1, tension: 80, friction: 20, easing: slowInOut };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePoOrbitCamera() {
  const phase       = usePoRaceStore(s => s.phase);
  const winnerLaneId = usePoRaceStore(s => s.winnerLaneId);

  const isOrbiting = phase === 'Finished';

  // Winner's actual world-Y = group offset + lane row position.
  const winnerY = winnerLaneId !== null
    ? WALL_OFFSET_Y + (PO_LANE_Y_POSITIONS[winnerLaneId - 1] ?? 0)
    : WALL_OFFSET_Y;

  const targetPos = isOrbiting
    ? [PO_HORSE_FINISH_X - 0.5, winnerY + 1.5, 6] as [number, number, number]
    : RACE_CAM_POS;

  const targetTgt = isOrbiting
    ? [PO_HORSE_FINISH_X, winnerY, 0] as [number, number, number]
    : RACE_CAM_TARGET;

  const [springs, api] = useSpring(() => ({
    springPosX: RACE_CAM_POS[0],
    springPosY: RACE_CAM_POS[1],
    springPosZ: RACE_CAM_POS[2],
    springTgtX: RACE_CAM_TARGET[0],
    springTgtY: RACE_CAM_TARGET[1],
    springTgtZ: RACE_CAM_TARGET[2],
    config: ORBIT_CONFIG,
  }));

  // Re-target spring whenever orbit state or winner changes.
  useEffect(() => {
    api.start({
      springPosX: targetPos[0],
      springPosY: targetPos[1],
      springPosZ: targetPos[2],
      springTgtX: targetTgt[0],
      springTgtY: targetTgt[1],
      springTgtZ: targetTgt[2],
      config: ORBIT_CONFIG,
    });
  }, [isOrbiting, winnerY, api]); // eslint-disable-line react-hooks/exhaustive-deps

  return { isOrbiting, springs };
}
