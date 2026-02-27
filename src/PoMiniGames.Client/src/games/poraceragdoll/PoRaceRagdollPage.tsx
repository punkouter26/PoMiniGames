import { useEffect, Suspense, lazy } from 'react';
import { useGameStore } from './store/gameStore';
import { GamePageShell } from '../shared/GamePageShell';
import GameUI from './components/GameUI';
import OddsBoard from './components/OddsBoard';
import './PoRaceRagdollPage.css';

const RaceCanvas = lazy(() => import('./components/RaceCanvas'));

export default function PoRaceRagdollPage() {
  const { state: gameState, hydrate, isHydrated, balance, round, maxRounds } = useGameStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  if (!isHydrated) {
    return (
      <GamePageShell title="PoRaceRagdoll" fullscreen>
        <div className="w-full h-full flex items-center justify-center bg-[#0a0a0a]">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-white/10 border-t-[#F72585] rounded-full animate-spin" />
            <p className="text-white/40 text-sm uppercase tracking-widest">Loading race...</p>
          </div>
        </div>
      </GamePageShell>
    );
  }

  return (
    <GamePageShell
      title="🏁 PoRaceRagdoll"
      stats={[
        { value: `$${balance.toLocaleString()}`, label: 'Balance' },
        { value: `${round}/${maxRounds}`, label: 'Round' },
      ]}
      fullscreen
    >
      <div className="relative w-full h-full overflow-hidden bg-[#0a0a0a]">
        {/* 3D Race Canvas — rendered behind the UI */}
        {gameState !== 'BETTING' && (
          <div className="absolute inset-0 z-0">
            <Suspense fallback={
              <div className="w-full h-full flex items-center justify-center">
                <div className="w-10 h-10 border-4 border-white/10 border-t-[#4CC9F0] rounded-full animate-spin" />
              </div>
            }>
              <RaceCanvas />
            </Suspense>
          </div>
        )}

        {/* Dark background when in betting phase */}
        {gameState === 'BETTING' && (
          <div className="absolute inset-0 z-0 bg-gradient-to-br from-[#0a0a1a] via-[#0d0d22] to-[#0a0a1a]" />
        )}

        {/* Overlay UI — sits above the canvas */}
        <div className="absolute inset-0 z-10">
          <GameUI />
          <OddsBoard />
        </div>
      </div>
    </GamePageShell>
  );
}
