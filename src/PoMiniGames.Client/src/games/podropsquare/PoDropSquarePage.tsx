import { useCallback, useEffect, useRef, useState } from 'react';
import { Trophy, RotateCcw, Star, Flame, ChevronRight } from 'lucide-react';
import { GamePageShell } from '../shared/GamePageShell';
import { usePlayerName } from '../../context/PlayerNameContext';
import { useDropSquarePhysics, type PhysicsCallbacks } from './useDropSquarePhysics';
import './PoDropSquarePage.css';

// ─── Types ───────────────────────────────────────────────────────────────────
type GameState = 'idle' | 'playing' | 'victory';

const API_BASE = import.meta.env.VITE_GAME_URL_PODROPSQUARE as string | undefined;

// ─── Main component ──────────────────────────────────────────────────────────
export default function PoDropSquarePage() {
  const { playerName } = usePlayerName();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [gameState, setGameState] = useState<GameState>('idle');
  const [blocksPlaced, setBlocksPlaced] = useState(0);
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const [dangerProgress, setDangerProgress] = useState(0); // 0–1
  const [isDanger, setIsDanger] = useState(false);
  const [survivalTime, setSurvivalTime] = useState(0);

  // Leaderboard / submission states
  const [initials, setInitials] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [isTop10, setIsTop10] = useState(false);
  const [top10Checked, setTop10Checked] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const score = blocksPlaced * Math.max(1, elapsedSecs);

  // ── Physics callbacks ────────────────────────────────────────────────────
  const callbacks: PhysicsCallbacks = {
    onDangerStart: () => setIsDanger(true),
    onDangerUpdate: (s) => setDangerProgress(s / 2),
    onDangerCancel: () => { setIsDanger(false); setDangerProgress(0); },
    onVictory: (t) => {
      setSurvivalTime(t);
      setGameState('victory');
      physics.current.stop();
      clearScoreTimer();
      checkTop10(t);
    },
    onBlockLanded: () => setBlocksPlaced(p => p + 1),
  };

  const physics = useDropSquarePhysics(canvasRef, callbacks, gameState !== 'idle');

  // ── Elapsed timer ────────────────────────────────────────────────────────
  function startScoreTimer() {
    timerRef.current = setInterval(() => {
      setElapsedSecs(s => s + 1);
    }, 1000);
  }

  function clearScoreTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }

  useEffect(() => () => clearScoreTimer(), []);

  // ── Start game ────────────────────────────────────────────────────────────
  function startGame() {
    clearScoreTimer();
    setBlocksPlaced(0);
    setElapsedSecs(0);
    setIsDanger(false);
    setDangerProgress(0);
    setSurvivalTime(0);
    setInitials('');
    setSubmitted(false);
    setIsTop10(false);
    setTop10Checked(false);
    setGameState('playing');
  }

  // Start physics when entering playing state
  useEffect(() => {
    if (gameState === 'playing') {
      physics.current.reset();
      physics.current.start();
      startScoreTimer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState]);

  // ── Canvas click → drop block ─────────────────────────────────────────────
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (gameState !== 'playing') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    // Physics world is 300px wide
    physics.current.dropBlock(xRatio * 300);
  }, [gameState, physics]);

  // ── Top-10 check ──────────────────────────────────────────────────────────
  async function checkTop10(t: number) {
    if (!API_BASE) { setTop10Checked(true); return; }
    try {
      const res = await fetch(`${API_BASE}/api/scores?top=10`);
      if (!res.ok) { setTop10Checked(true); return; }
      const data = await res.json() as {
        leaderboard?: { survivalTime: number }[];
      };
      const board = data.leaderboard ?? [];
      const tenthEntry = board[9];
      const qualifies = board.length < 10 || (tenthEntry !== undefined && t < tenthEntry.survivalTime);
      setIsTop10(qualifies);
    } catch { /* API not running */ }
    setTop10Checked(true);
  }

  // ── Score submission ──────────────────────────────────────────────────────
  async function submitScore() {
    if (!API_BASE || !initials.trim() || submitted) return;
    setSubmitting(true);
    try {
      await fetch(`${API_BASE}/api/scores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerInitials: initials.trim().toUpperCase().slice(0, 3),
          survivalTime,
          playerName: playerName || undefined,
        }),
      });
      setSubmitted(true);
    } catch { /* ignore */ }
    setSubmitting(false);
  }

  // ── Stability ─────────────────────────────────────────────────────────────
  const stabilityPct = Math.max(20, 100 - blocksPlaced * 3);
  const stabilityColor =
    stabilityPct > 70 ? '#00f5d4' : stabilityPct > 40 ? '#f8961e' : '#ef476f';

  // ── Stats bar ─────────────────────────────────────────────────────────────
  const stats =
    gameState !== 'idle'
      ? [
          { label: 'Score', value: score },
          { label: 'Blocks', value: blocksPlaced },
          { label: 'Time', value: `${elapsedSecs}s` },
        ]
      : [];

  return (
    <GamePageShell
      title={<><Star size={16} />{'  '}Drop Square</>}
      player={playerName || undefined}
      stats={stats}
      fullscreen
    >
      {/* ── Canvas wrapper ──────────────────────────────────── */}
      <div
        ref={wrapperRef}
        className="dsq-wrapper"
        onClick={handleCanvasClick}
      >
        <canvas ref={canvasRef} className="dsq-canvas" />

        {/* HUD: stability (bottom-left) */}
        {gameState === 'playing' && blocksPlaced > 0 && (
          <div className="dsq-hud dsq-hud-bl">
            <span className="dsq-hud-label">STABILITY</span>
            <div className="dsq-bar-track">
              <div
                className="dsq-bar-fill"
                style={{ width: `${stabilityPct}%`, background: stabilityColor }}
              />
            </div>
            <span className="dsq-hud-value" style={{ color: stabilityColor }}>
              {stabilityPct}%
            </span>
          </div>
        )}

        {/* HUD: danger countdown (bottom-right) */}
        {isDanger && (
          <div className="dsq-hud dsq-hud-br dsq-danger">
            <Flame size={14} />
            <div className="dsq-danger-ring">
              <svg viewBox="0 0 36 36" className="dsq-ring-svg">
                <circle cx="18" cy="18" r="14" className="dsq-ring-bg" />
                <circle
                  cx="18" cy="18" r="14"
                  className="dsq-ring-progress"
                  strokeDasharray={`${dangerProgress * 88} 88`}
                />
              </svg>
              <span className="dsq-ring-label">HOLD!</span>
            </div>
          </div>
        )}

        {/* ── Start overlay ──────────────────────────────────── */}
        {gameState === 'idle' && (
          <div className="dsq-overlay">
            <div className="dsq-overlay-card">
              <h2 className="dsq-overlay-title">Drop Square</h2>
              <p className="dsq-overlay-sub">
                Tap to drop blocks and build a tower.
                Hold a block at the red line for 2s to win!
              </p>
              <button className="dsq-btn dsq-btn-start" onClick={startGame}>
                <ChevronRight size={20} /> Start
              </button>
            </div>
          </div>
        )}

        {/* ── Victory overlay ────────────────────────────────── */}
        {gameState === 'victory' && (
          <div className="dsq-overlay dsq-overlay-victory">
            <div className="dsq-overlay-card">
              <Trophy size={40} className="dsq-trophy" />
              <h2 className="dsq-overlay-title">Victory!</h2>
              <p className="dsq-overlay-time">
                {survivalTime.toFixed(2)}s
              </p>
              <p className="dsq-overlay-score">Score: {score}</p>

              {/* Leaderboard submission */}
              {API_BASE && top10Checked && isTop10 && !submitted && (
                <div className="dsq-submit">
                  <p className="dsq-submit-label">🏆 You made the Top 10!</p>
                  <input
                    className="dsq-initials"
                    maxLength={3}
                    placeholder="AAA"
                    value={initials}
                    onChange={e => setInitials(e.target.value.toUpperCase())}
                  />
                  <button
                    className="dsq-btn dsq-btn-submit"
                    disabled={submitting || !initials.trim()}
                    onClick={submitScore}
                  >
                    {submitting ? 'Saving…' : 'Submit Score'}
                  </button>
                </div>
              )}

              {submitted && (
                <p className="dsq-submitted">✓ Score saved!</p>
              )}

              <button className="dsq-btn dsq-btn-restart" onClick={startGame}>
                <RotateCcw size={16} /> Play Again
              </button>
            </div>
          </div>
        )}
      </div>
    </GamePageShell>
  );
}
