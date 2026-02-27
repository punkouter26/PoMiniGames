import { useState, useEffect } from 'react';
import { useGameStore, type RoundResult } from '../store/gameStore';
import { audioManager } from '../lib/audio';

function PayoutBadge({ amount }: { amount: number }) {
    const isPositive = amount > 0;
    return (
        <span className={`text-3xl font-black tracking-tight ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
            {isPositive ? '+' : ''}{amount < 0 ? '-' : ''}${Math.abs(amount).toLocaleString()}
        </span>
    );
}

function RoundHistory({ history, maxRounds }: { history: RoundResult[]; maxRounds: number }) {
    if (history.length === 0) return null;
    return (
        <div className="flex items-center gap-2">
            {Array.from({ length: maxRounds }, (_, i) => {
                const result = history[i];
                if (!result) {
                    return <div key={i} className="w-3 h-3 rounded-full bg-white/10 border border-white/5" title={`Round ${i + 1}`} />;
                }
                return (
                    <div key={i}
                        className={`w-3.5 h-3.5 rounded-full transition-all ${result.playerWon
                            ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]'
                            : 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.6)]'}`}
                        title={`R${i + 1}: ${result.playerWon ? 'Won' : 'Lost'} (${result.winnerName})`}
                    />
                );
            })}
        </div>
    );
}

export default function GameUI() {
    const {
        balance, round, maxRounds, state: gameState,
        placeBet, selectedRacerId, nextRound, winnerId,
        racers, lastPayout, roundHistory, betAmount,
    } = useGameStore();

    const [showConfetti, setShowConfetti] = useState(false);

    const winner = racers.find(r => r.id === winnerId);
    const isWinner = winnerId === selectedRacerId;

    useEffect(() => {
        if (gameState === 'FINISHED') {
            if (isWinner) {
                audioManager.playWin();
                setShowConfetti(true);
                setTimeout(() => setShowConfetti(false), 3000);
            } else {
                audioManager.playLose();
            }
        }
    }, [gameState, isWinner]);

    const handlePlaceBet = () => {
        if (selectedRacerId === null) return;
        audioManager.playCoin();
        placeBet();
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Enter' && gameState === 'BETTING' && selectedRacerId !== null) {
                handlePlaceBet();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gameState, selectedRacerId]);

    const isGameOver = gameState === 'FINISHED' && round >= maxRounds;
    const totalPnL = roundHistory.reduce((acc, r) => acc + r.payout, 0);

    return (
        <div className="absolute inset-0 pointer-events-none z-50 flex flex-col justify-between font-sans">
            {/* TOP HUD BAR */}
            <div className="flex justify-between items-start w-full max-w-7xl mx-auto px-6 pt-4">
                <div className="glass-panel px-6 py-2.5 rounded-full flex flex-col items-center backdrop-blur-xl border-white/10 pointer-events-auto">
                    <span className="text-[9px] font-bold text-gray-400 uppercase tracking-[0.2em]">Balance</span>
                    <span className="text-2xl font-bold text-white tracking-tighter drop-shadow-lg">
                        ${balance.toLocaleString()}
                    </span>
                </div>

                <div className="flex flex-col items-center mt-2 gap-1">
                    <RoundHistory history={roundHistory} maxRounds={maxRounds} />
                </div>

                <div className="glass-panel px-6 py-2.5 rounded-full flex flex-col items-center backdrop-blur-xl border-white/10">
                    <span className="text-[9px] font-bold text-gray-400 uppercase tracking-[0.2em]">Round</span>
                    <div className="flex items-baseline gap-1">
                        <span className="text-2xl font-bold text-white tracking-tighter">{round}</span>
                        <span className="text-sm text-gray-500 font-bold">/ {maxRounds}</span>
                    </div>
                </div>
            </div>

            {/* CONFETTI */}
            {showConfetti && (
                <div className="absolute inset-0 z-[90] pointer-events-none overflow-hidden">
                    {Array.from({ length: 40 }, (_, i) => (
                        <div key={i} className="absolute w-2 h-2 rounded-full animate-confetti"
                            style={{
                                left: `${Math.random() * 100}%`,
                                top: `-5%`,
                                backgroundColor: ['#4CC9F0', '#F72585', '#7209B7', '#4361ee', '#FFD700', '#00FF88'][i % 6],
                                animationDelay: `${Math.random() * 2}s`,
                                animationDuration: `${2 + Math.random() * 2}s`,
                            }}
                        />
                    ))}
                </div>
            )}

            {/* RESULT MODAL */}
            {gameState === 'FINISHED' && (
                <div data-testid="result-modal" className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-md pointer-events-auto z-50 animate-in fade-in zoom-in duration-300">
                    <div className="flex flex-col items-center text-center p-12 glass-panel rounded-[2.5rem] border border-white/10 shadow-2xl relative overflow-hidden max-w-lg w-full mx-4">
                        <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 rounded-full blur-[100px] z-0 ${isWinner ? 'bg-green-500/20' : 'bg-red-500/20'}`} />

                        <div className="relative z-10 w-full">
                            <h2 className="text-sm font-bold text-white/50 uppercase tracking-[0.5em] mb-3">Result</h2>
                            <h1 data-testid="result-title"
                                className={`text-6xl md:text-8xl font-black mb-4 tracking-tighter ${isWinner
                                    ? 'text-transparent bg-clip-text bg-gradient-to-br from-[#4CC9F0] to-[#4361ee] drop-shadow-[0_0_30px_rgba(67,97,238,0.5)]'
                                    : 'text-transparent bg-clip-text bg-gradient-to-br from-[#ff006e] to-[#8338ec] drop-shadow-[0_0_30px_rgba(255,0,110,0.5)]'}`}>
                                {isWinner ? 'VICTORY' : 'DEFEAT'}
                            </h1>

                            <div className="glass-panel px-6 py-3 rounded-xl mb-4 inline-block">
                                <p className="text-lg text-gray-300 font-light uppercase tracking-widest">
                                    Winner: <span className="text-white font-bold">{winner?.name}</span>
                                </p>
                            </div>

                            <div className="mb-6">
                                <PayoutBadge amount={lastPayout} />
                                <p className="text-xs text-white/30 mt-1 uppercase tracking-widest">
                                    {isWinner ? 'Winnings' : 'Lost Bet'}
                                </p>
                            </div>

                            <div className="flex justify-center mb-6">
                                <RoundHistory history={roundHistory} maxRounds={maxRounds} />
                            </div>

                            {isGameOver && (
                                <div className="mb-6 glass-panel rounded-xl p-4">
                                    <h3 className="text-xs font-bold text-white/40 uppercase tracking-[0.3em] mb-2">Final Summary</h3>
                                    <div className="flex justify-center gap-6 text-sm">
                                        <div>
                                            <span className="text-white/40">Wins</span>
                                            <p className="text-green-400 font-bold text-lg">{roundHistory.filter(r => r.playerWon).length}</p>
                                        </div>
                                        <div>
                                            <span className="text-white/40">Losses</span>
                                            <p className="text-red-400 font-bold text-lg">{roundHistory.filter(r => !r.playerWon).length}</p>
                                        </div>
                                        <div>
                                            <span className="text-white/40">Total P/L</span>
                                            <p className={`font-bold text-lg ${totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                {totalPnL >= 0 ? '+' : ''}${totalPnL.toLocaleString()}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            <button onClick={nextRound} data-testid="next-round-button"
                                className="btn-primary px-14 py-4 text-lg w-full rounded-2xl shadow-xl hover:shadow-2xl hover:scale-[1.02] active:scale-[0.98]">
                                {isGameOver ? 'Play Again' : 'Next Round'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* BOTTOM BAR */}
            <div className="flex justify-center items-end pb-8">
                {gameState === 'BETTING' && (
                    <button onClick={handlePlaceBet} disabled={selectedRacerId === null}
                        data-testid="place-bet-button"
                        className={`pointer-events-auto px-16 py-5 font-bold text-lg uppercase tracking-[0.2em] transition-all duration-300 rounded-2xl ${selectedRacerId !== null
                            ? 'btn-primary shadow-[0_0_50px_rgba(247,37,133,0.4)] active:scale-95'
                            : 'bg-white/5 text-white/10 border border-white/5 cursor-not-allowed backdrop-blur-sm'}`}>
                        {selectedRacerId !== null ? `Race! — $${betAmount}` : 'Pick a Racer'}
                    </button>
                )}
            </div>
        </div>
    );
}
