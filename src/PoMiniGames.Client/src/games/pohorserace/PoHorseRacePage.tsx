/**
 * PoHorseRacePage.tsx — Entry point for the PoHorseRace mini game.
 *
 * Follows the PoMiniGames single-player game pattern:
 *   - Wrapped in GamePageShell for consistent header/back-button UI
 *   - Internal view state replaces React Router sub-routes (menu / playing / diag)
 *   - Game mode (normal | demo) set by PoHome then forwarded via context stores
 */

import { useState } from 'react';
import { GamePageShell } from '../shared/GamePageShell';
import { PoHome } from './pages/PoHome';
import { PoMidway } from './pages/PoMidway';
import { PoDiag } from './pages/PoDiag';
import type { PoGameMode } from './types/po-types';

type PoView = 'menu' | 'playing' | 'diag';

export default function PoHorseRacePage() {
  const [view, setView] = useState<PoView>('menu');
  // Keep track of mode so GamePageShell status badge can reflect it
  const [gameMode, setGameMode] = useState<PoGameMode>('normal');

  const handlePlay = (mode: PoGameMode) => {
    setGameMode(mode);
    setView('playing');
  };

  const modeLabel = gameMode === 'demo' ? 'Demo' : '1 Player';

  return (
    <GamePageShell
      title="PoHorseRace"
      status={view !== 'menu' ? modeLabel : undefined}
      backTo="/single-player"
      fullscreen={view !== 'menu'}
      offlineFriendly
    >
      {view === 'menu' && (
        <PoHome onPlay={handlePlay} />
      )}

      {view === 'playing' && (
        <PoMidway
          onDiag={() => setView('diag')}
          onBack={() => setView('menu')}
        />
      )}

      {view === 'diag' && (
        <PoDiag onBack={() => setView('playing')} />
      )}
    </GamePageShell>
  );
}
