/**
 * PoMidway.tsx — Main game page.
 *
 * Mounts the PoScene canvas and all in-world game components for Phase 3 + 4:
 *
 *   PoHorseWall     — 8-lane animated horse backdrop (T030/T039)
 *   PoLaneRamp      — 8 coloured inclined rolling lanes with holes (T041+)
 *   PoCameraRig     — orbit/race camera spring controller (T035)
 *   PoDiegeticButton RESET/DIAG — in-world buttons (T038)
 *   PoSummaryCard   — post-race floating results overlay (T036)
 *   PoTrough        — ball container + swipe input for lane 1 (T045)
 *   PoTargetTriangle — 5 scoring holes pyramid for lane 1 (T044/T052)
 *   PhysicsSyncMount — render-less; wires usePoPhysicsSync inside Physics (T047)
 */

import { useEffect } from 'react';
import type { JSX } from 'react';
import { PoScene } from '../components/PoScene';
import { PoHorseWall } from '../components/PoHorseWall';
import { PoLaneRamp, RAMP_CENTER_Y, RAMP_CENTER_Z, RAMP_INCLINE } from '../components/PoLaneRamp';
import { PoCameraRig } from '../components/PoCameraRig';
import { PoDiegeticButton } from '../components/PoDiegeticButton';
import { PoSummaryCard } from '../components/PoSummaryCard';
import { PoTrough } from '../components/PoTrough';
import { PoTargetTriangle } from '../components/PoTargetTriangle';
import { PoLane } from '../components/PoLane';
import { PoHud } from '../components/PoHud';
import { usePoPhysicsSync } from '../hooks/usePoPhysicsSync';
import { usePoDemoAutoplay } from '../hooks/usePoDemoAutoplay';
import { usePoLaneStore } from '../store/usePoLaneStore';
import { usePoBallStore } from '../store/usePoBallStore';
import { usePoGameModeStore } from '../store/usePoGameModeStore';
import { usePoRaceStore } from '../store/usePoRaceStore';

import { PO_LANE_X_POSITIONS } from '../components/PoHorseWall';

// ---------------------------------------------------------------------------
// Render-less physics sync mount (must live inside <Physics> boundary)
// ---------------------------------------------------------------------------

function PhysicsSyncMount(): null {
  usePoPhysicsSync();
  return null;
}

// ---------------------------------------------------------------------------
// PoMidway
// ---------------------------------------------------------------------------

interface PoMidwayProps {
  onDiag?: () => void;
  onBack?: () => void;
}

export function PoMidway({ onDiag }: PoMidwayProps): JSX.Element {
  usePoDemoAutoplay();
  const lanes = usePoLaneStore(s => s.lanes);
  const addScore = usePoLaneStore(s => s.addScore);
  const resetAllLanes = usePoLaneStore(s => s.resetAllLanes);
  const balls = usePoBallStore(s => s.balls);
  const resetAll = usePoBallStore(s => s.resetAll);
  const gameMode = usePoGameModeStore(s => s.gameMode);
  const phase = usePoRaceStore(s => s.phase);
  const startCountdown = usePoRaceStore(s => s.startCountdown);
  const resetRace = usePoRaceStore(s => s.resetRace);

  useEffect(() => {
    if (gameMode !== 'normal' || phase !== 'Idle') return;

    const timer = setTimeout(() => {
      if (usePoGameModeStore.getState().gameMode === 'normal' && usePoRaceStore.getState().phase === 'Idle') {
        usePoRaceStore.getState().startCountdown();
      }
    }, 900);

    return () => clearTimeout(timer);
  }, [gameMode, phase]);

  // FR-015: Render all 8 lanes with their geometric target triangles, 
  // ensuring the raised 3D rims appear uniformly across all lanes regardless of mode.
  const activeLaneIds = Array.from({ length: 8 }, (_, i) => i + 1);

  return (
    <div style={{ position: 'relative', width: '100dvw', height: '100dvh', overflow: 'hidden', background: '#05050f' }}>
      {/* HTML HUD overlay — always on top of the canvas */}
      <PoHud />

      {/* 2D fallback board so the game is still visually usable in browsers
          where the WebGL scene fails to paint. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 2,
          pointerEvents: 'none',
          paddingTop: '110px',
          background: 'radial-gradient(circle at top, rgba(32,32,64,0.32), rgba(5,5,15,0.92) 60%)',
        }}
      >
        <div style={{ width: '92%', maxWidth: '1200px', margin: '0 auto 14px', display: 'flex', justifyContent: 'center' }}>
          <button
            onClick={() => {
              if (phase === 'Idle') {
                startCountdown();
                return;
              }
              if (phase === 'Racing' && gameMode === 'normal') {
                addScore(1, 5);
                return;
              }
              if (phase === 'Finished') {
                resetRace();
                resetAllLanes();
                resetAll();
              }
            }}
            disabled={phase === 'Countdown'}
            style={{
              pointerEvents: 'auto',
              border: 'none',
              borderRadius: '999px',
              padding: '12px 22px',
              fontWeight: 800,
              fontSize: '14px',
              letterSpacing: '0.08em',
              background: phase === 'Finished' ? '#f59e0b' : gameMode === 'demo' ? '#64748b' : '#6bd968',
              color: '#041014',
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
              opacity: phase === 'Countdown' ? 0.6 : 1,
            }}
          >
            {phase === 'Idle' ? 'START RACE' : phase === 'Countdown' ? 'GET READY…' : phase === 'Finished' ? 'PLAY AGAIN' : gameMode === 'demo' ? 'DEMO RUNNING' : 'ROLL +5'}
          </button>
        </div>
        <div style={{ width: '94%', maxWidth: '1260px', margin: '0 auto' }}>
          {lanes.map((lane) => {
            const laneColors: Record<number, string> = {
              1: '#ef4444', 2: '#3b82f6', 3: '#eab308', 4: '#22c55e',
              5: '#f97316', 6: '#a855f7', 7: '#ec4899', 8: '#f8fafc',
            };
            const troughCount = balls.filter(ball => ball.laneId === lane.id && ball.phase === 'InTrough').length;
            const horseLeft = `${Math.max(14, Math.min(94, 14 + (lane.positionInches / 60) * 78))}%`;
            const fillWidth = `${Math.max(0, Math.min(100, (lane.positionInches / 60) * 100))}%`;
            const laneColor = laneColors[lane.id] ?? '#94a3b8';

            return (
              <div
                key={lane.id}
                style={{
                  position: 'relative',
                  height: '42px',
                  marginBottom: '12px',
                  borderRadius: '999px',
                  background: 'linear-gradient(90deg, rgba(10,16,40,0.92), rgba(10,10,22,0.92))',
                  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08), 0 3px 14px rgba(0,0,0,0.24)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: fillWidth,
                    background: `linear-gradient(90deg, ${laneColor}22, ${laneColor}10)`,
                  }}
                />
                <div style={{ position: 'absolute', left: '12px', top: '10px', color: '#cbd5e1', fontSize: '11px', fontWeight: 700, letterSpacing: '1px' }}>
                  LANE {lane.id}
                </div>
                <div style={{ position: 'absolute', left: '74px', top: '9px', display: 'flex', gap: '5px' }}>
                  {Array.from({ length: Math.max(1, troughCount) }).map((_, idx) => (
                    <span
                      key={idx}
                      style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '999px',
                        background: '#ffffff',
                        boxShadow: '0 0 6px rgba(255,255,255,0.8)',
                        opacity: idx < troughCount ? 1 : 0.25,
                        display: 'inline-block',
                      }}
                    />
                  ))}
                </div>
                <div style={{ position: 'absolute', right: '26px', top: '7px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <span style={{ color: '#c084fc', fontSize: '10px', fontWeight: 700 }}>1</span>
                  <span style={{ color: '#60a5fa', fontSize: '10px', fontWeight: 700 }}>2</span>
                  <span style={{ color: '#4ade80', fontSize: '10px', fontWeight: 700 }}>3</span>
                  <span style={{ color: '#facc15', fontSize: '10px', fontWeight: 700 }}>5</span>
                </div>
                <div style={{ position: 'absolute', right: '10px', top: '0', bottom: '0', width: '2px', background: '#ffd700', opacity: 0.9 }} />
                <div
                  style={{
                    position: 'absolute',
                    left: horseLeft,
                    top: '7px',
                    transform: 'translateX(-50%)',
                    fontSize: '22px',
                    filter: lane.goldGlowActive ? 'drop-shadow(0 0 7px gold)' : `drop-shadow(0 0 5px ${laneColor})`,
                  }}
                >
                  🏇
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <PoScene
        staticChildren={(
          <>
            {/* Horse race backdrop, LED clocks, and animated horses */}
            <PoHorseWall />

            {/* Camera orbit animation rig (render-less) */}
            <PoCameraRig />

            {/* RESET button — start countdown (Idle) or reset race (Racing/Finished) */}
            <PoDiegeticButton label="RESET" position={[-1.2, -0.6, 4]} />

            {/* DIAG button — navigate to diagnostics screen */}
            <PoDiegeticButton label="DIAG" position={[1.2, -0.6, 4]} onDiag={onDiag} />

            {/* Post-race floating summary — visible only when phase === 'Finished' */}
            <PoSummaryCard />
          </>
        )}
        physicsChildren={(
          <>
            {/* Physics sync hook (render-less, inside Physics boundary) */}
            <PhysicsSyncMount />

            {/* 8 coloured inclined ramps with 10 decorative holes each */}
            <PoLaneRamp />

            {activeLaneIds.map(laneId => {
              const laneX = PO_LANE_X_POSITIONS[laneId - 1]!;
              return (
                <group
                  key={laneId}
                  position={[laneX, RAMP_CENTER_Y, RAMP_CENTER_Z]}
                  rotation={[RAMP_INCLINE, 0, 0]}
                >
                  <PoTrough laneId={laneId} />
                  <PoTargetTriangle laneId={laneId} />
                  <PoLane />
                </group>
              );
            })}
          </>
        )}
      />
    </div>
  );
}

