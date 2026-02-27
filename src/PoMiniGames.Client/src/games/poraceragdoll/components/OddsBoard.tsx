import { useEffect, useCallback, Suspense, lazy } from 'react';
import { useGameStore } from '../store/gameStore';
import { audioManager } from '../lib/audio';

const RagdollPreview = lazy(() => import('./RagdollPreview'));

function OddsBadge({ odds }: { odds: number }) {
    const isFavorite = odds < 0;
    const winProbability = isFavorite
        ? Math.round(100 * (100 / (100 + Math.abs(odds))))
        : Math.round(100 * (odds / (100 + odds)));
    return (
        <span
            className={`px-3 py-1 rounded-full text-xs font-black tracking-wide cursor-help ${isFavorite
                ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                : 'bg-green-500/20 text-green-300 border border-green-500/30'}`}
            title={`Win probability: ${winProbability}%`}
        >
            {odds > 0 ? '+' : ''}{odds}
        </span>
    );
}

function WinProbability({ odds }: { odds: number }) {
    const isFavorite = odds < 0;
    const winProbability = isFavorite
        ? Math.round(100 * (100 / (100 + Math.abs(odds))))
        : Math.round(100 * (odds / (100 + odds)));
    return (
        <div className="flex items-center gap-1 mt-1" title={`Historical win rate: ${winProbability}%`}>
            <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${isFavorite ? 'bg-red-400' : 'bg-green-400'}`} style={{ width: `${winProbability}%` }} />
            </div>
            <span className="text-[10px] text-white/40">{winProbability}%</span>
        </div>
    );
}

export default function OddsBoard() {
    const { racers, selectedRacerId, selectRacer, state: gameState, roundHistory } = useGameStore();

    const handleRacerClick = useCallback((racerId: number) => {
        audioManager.playCoin();
        selectRacer(racerId);
    }, [selectRacer]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (gameState !== 'BETTING') return;
            const num = parseInt(e.key);
            if (num >= 1 && num <= 8) {
                const racer = racers[num - 1];
                if (racer) handleRacerClick(racer.id);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [gameState, racers, handleRacerClick]);

    if (gameState !== 'BETTING') return null;

    const totalWins = roundHistory.filter(r => r.playerWon).length;
    const totalPlayed = roundHistory.length;
    const winRate = totalPlayed > 0 ? Math.round((totalWins / totalPlayed) * 100) : 0;

    return (
        <div data-testid="odds-board" className="absolute inset-0 z-40 flex flex-col pointer-events-none bg-gradient-to-b from-black/70 via-black/40 to-black/70">
            <div className="flex-shrink-0 pt-20 pb-2 px-6">
                <div className="flex items-center justify-between max-w-[1600px] mx-auto">
                    <div className="text-center flex-1">
                        <h2 className="text-white/90 text-2xl font-black uppercase tracking-[0.4em] drop-shadow-lg animate-fade-in-down">
                            Choose Your Champion
                        </h2>
                        <p className="text-white/40 text-xs mt-1 tracking-widest animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                            Click or press 1-8 to select &bull; Press BET to start
                        </p>
                    </div>
                    {totalPlayed > 0 && (
                        <div className="glass-panel-enhanced rounded-xl px-4 py-2 flex items-center gap-4 animate-fade-in-right">
                            <div className="text-center">
                                <p className="text-[10px] text-white/40 uppercase tracking-wider">Win Rate</p>
                                <p className={`text-lg font-black ${winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>{winRate}%</p>
                            </div>
                            <div className="w-px h-8 bg-white/10" />
                            <div className="text-center">
                                <p className="text-[10px] text-white/40 uppercase tracking-wider">Wins</p>
                                <p className="text-lg font-black text-green-400">{totalWins}</p>
                            </div>
                            <div className="w-px h-8 bg-white/10" />
                            <div className="text-center">
                                <p className="text-[10px] text-white/40 uppercase tracking-wider">Played</p>
                                <p className="text-lg font-black text-white/70">{totalPlayed}</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <div className="flex-1 relative px-3 pb-20 min-h-0">
                <div data-testid="racer-grid" className="relative h-full grid grid-cols-4 grid-rows-2 gap-2 max-w-[1600px] mx-auto">
                    {racers.map((racer, index) => {
                        const isSelected = selectedRacerId === racer.id;
                        const laneNumber = index + 1;
                        const racerColor = racer.color || '#ffffff';

                        return (
                            <div
                                key={racer.id}
                                data-testid={`racer-card-${racer.id}`}
                                onClick={() => handleRacerClick(racer.id)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        handleRacerClick(racer.id);
                                    }
                                }}
                                role="button"
                                tabIndex={0}
                                aria-pressed={isSelected}
                                aria-label={`Select ${racer.name}, Lane ${laneNumber}, Odds ${racer.odds > 0 ? '+' : ''}${racer.odds}, Mass ${racer.mass}kg`}
                                className={`pointer-events-auto cursor-pointer relative flex flex-col rounded-xl overflow-hidden transition-all duration-300 hover-lift focus-ring ${isSelected
                                    ? 'ring-3 ring-[#F72585] shadow-[0_0_40px_rgba(247,37,133,0.5)] scale-[1.02] z-20 animate-scale-in'
                                    : 'ring-1 ring-white/10 hover:ring-white/30'}`}
                                style={{
                                    borderLeft: `3px solid ${isSelected ? '#F72585' : racerColor}40`,
                                    animationDelay: `${index * 50}ms`,
                                }}
                            >
                                <div className={`flex items-center justify-between px-3 py-1.5 backdrop-blur-md ${isSelected ? 'bg-gradient-to-r from-[#7209B7]/80 to-[#F72585]/80' : 'bg-black/60'}`}>
                                    <div className="flex items-center gap-2">
                                        <span className={`w-6 h-6 flex items-center justify-center rounded-md font-black text-sm ${isSelected ? 'bg-white/20 text-white' : 'bg-white/10 text-white/60'}`}>
                                            {laneNumber}
                                        </span>
                                        <span className={`font-bold uppercase tracking-wider text-xs ${isSelected ? 'text-white' : 'text-white/70'}`}>
                                            Lane {laneNumber}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <OddsBadge odds={racer.odds} />
                                        {isSelected && (
                                            <div className="flex items-center gap-1.5 bg-white/20 px-2 py-0.5 rounded-full">
                                                <div className="w-1.5 h-1.5 bg-[#4CC9F0] rounded-full animate-pulse shadow-[0_0_8px_#4CC9F0]" />
                                                <span className="text-[10px] font-bold text-white">PICK</span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="flex-1 relative min-h-0">
                                    <Suspense fallback={<div className="w-full h-full bg-black/20" />}>
                                        <RagdollPreview racerType={racer.type} isSelected={isSelected} />
                                    </Suspense>
                                    <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />
                                    <div className="absolute inset-x-0 top-0 h-8 opacity-20 pointer-events-none"
                                        style={{ background: `linear-gradient(to bottom, ${racerColor}, transparent)` }} />
                                </div>

                                <div className={`px-3 py-2 backdrop-blur-md ${isSelected ? 'bg-black/70' : 'bg-black/50'}`}>
                                    <h3 data-testid={`racer-name-${racer.id}`}
                                        className={`text-base font-black uppercase tracking-wide mb-1 ${isSelected
                                            ? 'text-transparent bg-clip-text bg-gradient-to-r from-[#4CC9F0] to-[#F72585]'
                                            : 'text-white/90'}`}>
                                        {racer.name}
                                    </h3>
                                    <div className="flex items-center gap-1.5">
                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${isSelected ? 'bg-[#7209B7]/50 text-white' : 'bg-white/10 text-white/60'}`}>
                                            {racer.species}
                                        </span>
                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${isSelected ? 'bg-white/20 text-white' : 'bg-white/10 text-white/60'}`}>
                                            {racer.mass}kg
                                        </span>
                                        <WinProbability odds={racer.odds} />
                                        <div className="ml-auto w-5 h-5 rounded-full border-2 shadow-sm"
                                            style={{ backgroundColor: racerColor, borderColor: isSelected ? 'white' : 'rgba(255,255,255,0.3)', boxShadow: `0 0 8px ${racerColor}40` }} />
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
