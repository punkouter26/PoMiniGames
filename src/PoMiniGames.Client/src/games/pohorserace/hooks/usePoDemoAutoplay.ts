import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { PO_HOLE_POSITIONS } from '../components/PoLaneRamp';
import { usePoBallStore } from '../store/usePoBallStore';
import { usePoGameModeStore } from '../store/usePoGameModeStore';
import { usePoInputModeStore } from '../store/usePoInputModeStore';
import { usePoLaneStore } from '../store/usePoLaneStore';
import { usePoRaceStore } from '../store/usePoRaceStore';
import { poToMph } from '../utils/PoMphConverter';

const TROUGH_Z = 2.4;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clearTimer(timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>): void {
  if (timerRef.current !== null) {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}

function clearIntervalRef(timerRef: MutableRefObject<ReturnType<typeof setInterval> | null>): void {
  if (timerRef.current !== null) {
    clearInterval(timerRef.current);
    timerRef.current = null;
  }
}

function attemptCpuLaunch(): void {
  const ballStore = usePoBallStore.getState();
  const availableLanes = Array.from({ length: 8 }, (_, i) => i + 1).filter(laneId =>
    ballStore.canLaunch(laneId)
  );
  if (availableLanes.length === 0) return;

  const laneId = availableLanes[Math.floor(Math.random() * availableLanes.length)]!;
  const target = PO_HOLE_POSITIONS[Math.floor(Math.random() * PO_HOLE_POSITIONS.length)]!;

  // Extremely low jitter so balls reliably fall into the physical holes
  const jitterX = randomBetween(-0.01, 0.01);
  const jitterZ = randomBetween(-0.02, 0.02);
  const deltaX = target.lx + jitterX;
  const deltaZ = target.lz - TROUGH_Z + jitterZ;

  const ix = Math.max(-0.28, Math.min(0.28, deltaX * 0.22 + randomBetween(-0.01, 0.01)));
  const iy = randomBetween(0.04, 0.07);
  const iz = Math.max(-1.28, Math.min(-0.72, deltaZ * 0.24 + randomBetween(-0.02, 0.02)));

  const magnitude = Math.sqrt(ix * ix + iy * iy + iz * iz);
  const scale = magnitude > 1.3 ? 1.3 / magnitude : 1;
  const impulse = {
    ix: ix * scale,
    iy: iy * scale,
    iz: iz * scale,
  };

  const launchedBallId = ballStore.launchBallFromLane(laneId, impulse, Math.max(0, poToMph(Math.sqrt(
    impulse.ix * impulse.ix + impulse.iy * impulse.iy + impulse.iz * impulse.iz
  ))));

  if (launchedBallId === null) return;
}

export function usePoDemoAutoplay(): void {
  const phase = usePoRaceStore(s => s.phase);
  const gameMode = usePoGameModeStore(s => s.gameMode);

  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fireIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (gameMode !== 'demo') {
      clearTimer(startTimerRef);
      clearIntervalRef(fireIntervalRef);
      return;
    }

    usePoInputModeStore.getState().setInputMode('slingshot');

    if (phase === 'Idle' && startTimerRef.current === null) {
      startTimerRef.current = setTimeout(() => {
        startTimerRef.current = null;
        const race = usePoRaceStore.getState();
        if (race.phase === 'Idle' && usePoGameModeStore.getState().gameMode === 'demo') {
          race.startCountdown();
        }
      }, 800);
    }

    if (phase === 'Racing' && fireIntervalRef.current === null) {
      clearTimer(startTimerRef);
      // Browser-safe fallback autoplay: still attempts real launches, but also
      // advances lanes directly so the demo visibly races even if WebGL/Rapier
      // is degraded in the VS Code browser.
      fireIntervalRef.current = setInterval(() => {
        if (usePoGameModeStore.getState().gameMode !== 'demo') return;
        if (usePoRaceStore.getState().phase !== 'Racing') return;

        attemptCpuLaunch();

        const laneId = Math.floor(Math.random() * 8) + 1;
        const pointOptions = [1, 1, 2, 2, 3, 5] as const;
        const points = pointOptions[Math.floor(Math.random() * pointOptions.length)]!;
        usePoLaneStore.getState().addScore(laneId, points * 2);
      }, 350);
    }

    if (phase !== 'Racing') {
      clearIntervalRef(fireIntervalRef);
    }

    return () => {
      if (phase !== 'Idle') {
        clearTimer(startTimerRef);
      }
    };
  }, [gameMode, phase]);

  useEffect(() => () => {
    clearTimer(startTimerRef);
    clearIntervalRef(fireIntervalRef);
  }, []);
}
