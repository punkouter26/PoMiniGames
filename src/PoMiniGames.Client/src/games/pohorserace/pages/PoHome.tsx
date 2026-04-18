/**
 * PoHome.tsx — Splash / home screen.
 *
 * Displays the game title, a tagline, and a START button that navigates
 * to the main game route (/game). Arcade-dark theme to match the in-game
 * aesthetic.
 */

import type { JSX } from 'react';
import type { PoGameMode } from '../types/po-types';
import { usePoGameModeStore } from '../store/usePoGameModeStore';
import { usePoInputModeStore } from '../store/usePoInputModeStore';
import { usePoRaceStore } from '../store/usePoRaceStore';
import { usePoLaneStore } from '../store/usePoLaneStore';
import { usePoBallStore } from '../store/usePoBallStore';

// ---------------------------------------------------------------------------
// PoHome
// ---------------------------------------------------------------------------

interface PoHomeProps {
  onPlay: (mode: PoGameMode) => void;
}

export function PoHome({ onPlay }: PoHomeProps): JSX.Element {
  const setGameMode = usePoGameModeStore(s => s.setGameMode);
  const setInputMode = usePoInputModeStore(s => s.setInputMode);

  const startNormal = () => {
    setGameMode('normal');
    usePoRaceStore.getState().resetRace();
    usePoLaneStore.getState().resetAllLanes();
    usePoBallStore.getState().resetAll();
    onPlay('normal');
  };

  const startDemo = () => {
    setGameMode('demo');
    setInputMode('slingshot');
    usePoRaceStore.getState().resetRace();
    usePoLaneStore.getState().resetAllLanes();
    usePoBallStore.getState().resetAll();
    onPlay('demo');
  };

  return (
    <div
      style={{
        width: '100dvw',
        height: '100dvh',
        background: '#05050f',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        overflow: 'hidden',
        position: 'relative',
        userSelect: 'none',
      }}
    >
      {/* ── Decorative track lines ── */}
      {[...Array(8)].map((_, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${(i / 8) * 100}%`,
            width: '1px',
            background:
              'linear-gradient(to bottom, transparent, rgba(255,255,255,0.03), transparent)',
            pointerEvents: 'none',
          }}
        />
      ))}

      {/* ── Horse emoji row ── */}
      <div
        style={{
          fontSize: 'clamp(1.5rem, 5vw, 2.5rem)',
          letterSpacing: '0.5em',
          marginBottom: '1.5rem',
          opacity: 0.7,
        }}
      >
        🏇🏇🏇🏇🏇🏇🏇🏇
      </div>

      {/* ── Title ── */}
      <h1
        style={{
          fontSize: 'clamp(2.8rem, 12vw, 6rem)',
          fontWeight: 900,
          letterSpacing: '0.04em',
          color: '#ffffff',
          textShadow: [
            '0 0 12px #ff6b35',
            '0 0 30px rgba(255,107,53,0.6)',
            '0 0 60px rgba(255,107,53,0.3)',
          ].join(', '),
          margin: 0,
          textAlign: 'center',
          lineHeight: 1.1,
        }}
      >
        PoHorseRace
      </h1>

      {/* ── Tagline ── */}
      <p
        style={{
          color: '#8888aa',
          fontSize: 'clamp(0.75rem, 2.5vw, 1rem)',
          letterSpacing: '0.25em',
          textTransform: 'uppercase',
          margin: '1rem 0 3rem',
        }}
      >
        Roll • Score • Race
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', alignItems: 'center' }}>
        <button
          onClick={startNormal}
          style={{
            padding: '1rem 4rem',
            fontSize: 'clamp(1.1rem, 4vw, 1.5rem)',
            fontWeight: 800,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            background: 'linear-gradient(135deg, #ff6b35 0%, #ff9f1c 100%)',
            color: '#05050f',
            border: 'none',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            boxShadow: '0 0 24px rgba(255,107,53,0.55), 0 4px 16px rgba(0,0,0,0.5)',
            transition: 'transform 0.1s, box-shadow 0.1s',
          }}
          onPointerDown={e => {
            (e.currentTarget as HTMLButtonElement).style.transform = 'scale(0.96)';
          }}
          onPointerUp={e => {
            (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)';
          }}
        >
          Start
        </button>

        <button
          onClick={startDemo}
          style={{
            padding: '0.9rem 3.1rem',
            fontSize: 'clamp(0.95rem, 3.2vw, 1.2rem)',
            fontWeight: 800,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            background: 'linear-gradient(135deg, #0ea5e9 0%, #22d3ee 100%)',
            color: '#041019',
            border: 'none',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            boxShadow: '0 0 20px rgba(34,211,238,0.45), 0 4px 16px rgba(0,0,0,0.5)',
            transition: 'transform 0.1s, box-shadow 0.1s',
          }}
          onPointerDown={e => {
            (e.currentTarget as HTMLButtonElement).style.transform = 'scale(0.96)';
          }}
          onPointerUp={e => {
            (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)';
          }}
        >
          Demo
        </button>
      </div>

      {/* ── Version pill ── */}
      <p
        style={{
          position: 'absolute',
          bottom: '1.25rem',
          color: '#444466',
          fontSize: '0.7rem',
          letterSpacing: '0.1em',
        }}
      >
        v0.1.0 · offline
      </p>
    </div>
  );
}
