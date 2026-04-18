/**
 * PoHud.tsx — Top-of-screen HTML overlay HUD.
 *
 * Shows:
 *  • Score            — top-left corner (player lane score)
 *  • Elapsed time     — ms-precision via RAF
 *  • Leader           — horse currently in 1st place
 *  • Swipe/Sling      — input mode toggle
 */

import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { usePoRaceStore } from '../store/usePoRaceStore';
import { usePoLaneStore } from '../store/usePoLaneStore';
import { usePoInputModeStore } from '../store/usePoInputModeStore';
import { usePoGameModeStore } from '../store/usePoGameModeStore';

// ---------------------------------------------------------------------------
// Lane colour palette (shared by score badge, leader dot, etc.)
// ---------------------------------------------------------------------------
const LANE_COLORS: Record<number, string> = {
    1: '#ef4444', 2: '#3b82f6', 3: '#eab308', 4: '#22c55e',
    5: '#f97316', 6: '#a855f7', 7: '#ec4899', 8: '#e5e7eb',
};

// ---------------------------------------------------------------------------
// PoHud
// ---------------------------------------------------------------------------

export function PoHud(): JSX.Element {
    const phase = usePoRaceStore(s => s.phase);

    // High-resolution elapsed display
    const raceStartRef = useRef<number | null>(null);
    const [displayMs, setDisplayMs] = useState(0);

    useEffect(() => {
        if (phase === 'Racing') {
            raceStartRef.current = performance.now();
            setDisplayMs(0);
        } else if (phase === 'Idle' || phase === 'Countdown') {
            raceStartRef.current = null;
            setDisplayMs(0);
        }
    }, [phase]);

    useEffect(() => {
        if (phase !== 'Racing') return;
        let rafId: number;
        const tick = () => {
            if (raceStartRef.current !== null) {
                setDisplayMs(performance.now() - raceStartRef.current);
            }
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafId);
    }, [phase]);

    // Lanes
    const lanes = usePoLaneStore(s => s.lanes);

    // Leader
    const leader = lanes.reduce((best, lane) => {
        if (lane.positionInches > best.positionInches) return lane;
        if (lane.positionInches === best.positionInches && lane.id < best.id) return lane;
        return best;
    }, lanes[0]!);

    // Player score
    const playerLane = lanes.find(l => l.isPlayerControlled);
    const playerScore = playerLane?.score ?? 0;
    const playerColor = LANE_COLORS[playerLane?.id ?? 1] ?? '#ef4444';

    // Display strings
    const totalSec = Math.floor(displayMs / 1000);
    const ms = Math.floor(displayMs % 1000);
    const timeStr = `${totalSec}.${String(ms).padStart(3, '0')}`;
    const leaderColor = LANE_COLORS[leader?.id ?? 1] ?? '#ffffff';

    // Input mode
    const inputMode = usePoInputModeStore(s => s.inputMode);
    const toggleInputMode = usePoInputModeStore(s => s.toggleInputMode);
    const isSwipe = inputMode === 'swipe';
    const gameMode = usePoGameModeStore(s => s.gameMode);

    return (
        <>
            {/* ── Score badge — top-left corner ──────────────────────────────── */}
            <div
                style={{
                    position: 'absolute',
                    top: '12px',
                    left: '16px',
                    zIndex: 101,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    pointerEvents: 'none',
                    userSelect: 'none',
                    fontFamily: "'Courier New', monospace",
                }}
            >
                <span style={{ fontSize: '10px', letterSpacing: '2px', color: '#aaa', textTransform: 'uppercase' }}>
                    Score
                </span>
                <span
                    style={{
                        fontSize: '42px',
                        fontWeight: 'bold',
                        lineHeight: 1,
                        color: playerColor,
                        textShadow: `0 0 16px ${playerColor}99`,
                        letterSpacing: '1px',
                    }}
                >
                    {playerScore}
                </span>
            </div>

            {/* ── Main HUD bar — top centre ───────────────────────────────────── */}
            <div
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 100,
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    gap: '2rem',
                    padding: '10px 24px',
                    background: 'linear-gradient(180deg, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0) 100%)',
                    pointerEvents: 'none',
                    fontFamily: "'Courier New', monospace",
                    userSelect: 'none',
                }}
            >
                {/* Elapsed */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', letterSpacing: '2px', color: '#aaa', textTransform: 'uppercase' }}>
                        Elapsed
                    </span>
                    <span
                        style={{
                            fontSize: '28px',
                            fontWeight: 'bold',
                            color: phase === 'Racing' ? '#ffffff' : '#666',
                            textShadow: phase === 'Racing' ? '0 0 12px rgba(255,255,255,0.5)' : 'none',
                            letterSpacing: '2px',
                            minWidth: '120px',
                            textAlign: 'center',
                        }}
                    >
                        {phase === 'Idle' || phase === 'Countdown' ? '0.000' : timeStr}s
                    </span>
                </div>

                <div style={{ width: '1px', height: '40px', background: 'rgba(255,255,255,0.2)' }} />

                {/* Leader */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', letterSpacing: '2px', color: '#aaa', textTransform: 'uppercase' }}>
                        Leader
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div
                            style={{
                                width: '14px', height: '14px', borderRadius: '50%',
                                backgroundColor: leaderColor, boxShadow: `0 0 8px ${leaderColor}`, flexShrink: 0,
                            }}
                        />
                        <span style={{ fontSize: '28px', fontWeight: 'bold', color: leaderColor, textShadow: `0 0 12px ${leaderColor}80`, letterSpacing: '2px' }}>
                            Horse {leader?.id ?? '—'}
                        </span>
                    </div>
                </div>

                <div style={{ width: '1px', height: '40px', background: 'rgba(255,255,255,0.2)' }} />

                {/* Swipe / Slingshot toggle */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', letterSpacing: '2px', color: '#aaa', textTransform: 'uppercase' }}>
                        Mode
                    </span>
                    <button
                        onClick={() => {
                            if (gameMode !== 'demo') {
                                toggleInputMode();
                            }
                        }}
                        style={{
                            pointerEvents: 'auto',
                            background: isSwipe
                                ? 'linear-gradient(135deg, #1e40af, #3b82f6)'
                                : 'linear-gradient(135deg, #7c2d12, #ea580c)',
                            border: 'none', borderRadius: '20px', padding: '4px 16px',
                            cursor: 'pointer', display: 'flex', gap: '6px', alignItems: 'center',
                            transition: 'all 0.2s ease',
                            boxShadow: isSwipe ? '0 0 10px rgba(59,130,246,0.5)' : '0 0 10px rgba(234,88,12,0.5)',
                            opacity: gameMode === 'demo' ? 0.5 : 1,
                        }}
                        disabled={gameMode === 'demo'}
                    >
                        <span style={{ fontSize: '13px', fontWeight: 'bold', letterSpacing: '1px', color: isSwipe ? '#93c5fd' : '#fed7aa', opacity: isSwipe ? 1 : 0.5, transition: 'all 0.2s' }}>SWIPE</span>
                        <span style={{ color: '#666', fontSize: '11px' }}>|</span>
                        <span style={{ fontSize: '13px', fontWeight: 'bold', letterSpacing: '1px', color: isSwipe ? '#fed7aa' : '#fdba74', opacity: isSwipe ? 0.5 : 1, transition: 'all 0.2s' }}>SLING</span>
                    </button>
                </div>
            </div>
        </>
    );
}
