import { useState, useEffect, useRef, useCallback } from 'react';
import { Difficulty, GameResult } from '../shared/types';
import { statsService } from '../shared/statsService';
import { usePlayerName } from '../../context/PlayerNameContext';
import { GamePageShell, type StatItem } from '../shared/GamePageShell';
import './pobabytouch.css';

const GAME_KEY = 'pobabytouch';

// ─── Config per difficulty ───────────────────────────────────
const DIFF_CONFIG: Record<Difficulty, { target: number; timeLimit: number; spawnMs: number; maxBubbles: number }> = {
  [Difficulty.Easy]:   { target: 10, timeLimit: 30, spawnMs: 1600, maxBubbles: 8 },
  [Difficulty.Medium]: { target: 18, timeLimit: 30, spawnMs: 1100, maxBubbles: 10 },
  [Difficulty.Hard]:   { target: 28, timeLimit: 30, spawnMs: 700,  maxBubbles: 12 },
};

// ─── Bubble palette ─────────────────────────────────────────
const COLORS = [
  '#f472b6', '#a78bfa', '#34d399', '#fbbf24',
  '#60a5fa', '#fb923c', '#f87171', '#4ade80',
];
const EMOJIS = ['⭐', '🌈', '🎈', '🍭', '💎', '🌸', '🦋', '🎀', '🍬', '✨'];

interface Bubble {
  id: number;
  x: number;   // % from left
  y: number;   // % from top
  size: number; // px
  color: string;
  emoji: string;
  drift: number; // animation duration s
  offset: number; // animation delay s
}

interface PopParticle {
  id: number;
  x: number;
  y: number;
  emoji: string;
}

type GamePhase = 'idle' | 'playing' | 'result';

// ─── Web Audio helpers ───────────────────────────────────────
function createAudioCtx() {
  try { return new (window.AudioContext || (window as any).webkitAudioContext)(); }
  catch { return null; }
}

function playPop(ctx: AudioContext | null, color: string) {
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  // Map color to rough freq for variety
  const freq = 400 + (COLORS.indexOf(color) / COLORS.length) * 600;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 2, t + 0.08);
  gain.gain.setValueAtTime(0.25, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.15);
}

function playWin(ctx: AudioContext | null) {
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  [523, 659, 784, 1047].forEach((freq, i) => {
    const t = ctx.currentTime + i * 0.12;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.25);
  });
}

export default function PoBabyTouchPage() {
  const { playerName } = usePlayerName();
  const [difficulty, setDifficulty] = useState(Difficulty.Medium);
  const [stats, setStats] = useState(() => statsService.getStats(GAME_KEY, playerName));

  const [phase, setPhase] = useState<GamePhase>('idle');
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(30);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [pops, setPops] = useState<PopParticle[]>([]);
  const [lastResult, setLastResult] = useState<GameResult | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextIdRef = useRef(0);
  const scoreRef = useRef(0);
  const phaseRef = useRef<GamePhase>('idle');
  const configRef = useRef(DIFF_CONFIG[difficulty]);

  // Keep refs in sync
  useEffect(() => { configRef.current = DIFF_CONFIG[difficulty]; }, [difficulty]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { scoreRef.current = score; }, [score]);

  const endGame = useCallback(async (won: boolean) => {
    setPhase('result');
    const result = won ? GameResult.Win : GameResult.Loss;
    setLastResult(result);
    setBubbles([]);
    if (won) playWin(audioCtxRef.current);
    const updated = await statsService.recordResult(GAME_KEY, playerName, difficulty, result);
    setStats(updated);
  }, [playerName, difficulty]);

  // ── Game timer ─────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'playing') return;
    const cfg = configRef.current;
    setTimeLeft(cfg.timeLimit);
    const tid = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(tid);
          if (phaseRef.current === 'playing') endGame(scoreRef.current >= cfg.target);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(tid);
  }, [phase, endGame]);

  // ── Bubble spawner ──────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'playing') return;
    const cfg = configRef.current;
    const spawn = () => {
      if (phaseRef.current !== 'playing') return;
      setBubbles(prev => {
        if (prev.length >= cfg.maxBubbles) return prev;
        const size = 60 + Math.random() * 60;
        const margin = (size / 2 / window.innerWidth) * 100;
        return [...prev, {
          id: nextIdRef.current++,
          x: margin + Math.random() * (100 - margin * 2),
          y: 5 + Math.random() * 80,
          size,
          color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
          emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)]!,
          drift: 2 + Math.random() * 3,
          offset: Math.random() * -3,
        }];
      });
    };
    spawn();
    const tid = setInterval(spawn, cfg.spawnMs);
    return () => clearInterval(tid);
  }, [phase]);

  const startGame = () => {
    if (!audioCtxRef.current) audioCtxRef.current = createAudioCtx();
    nextIdRef.current = 0;
    scoreRef.current = 0;
    setScore(0);
    setBubbles([]);
    setPops([]);
    setLastResult(null);
    setPhase('playing');
  };

  const popBubble = (bubble: Bubble) => {
    if (phaseRef.current !== 'playing') return;
    playPop(audioCtxRef.current, bubble.color);

    // Remove bubble
    setBubbles(prev => prev.filter(b => b.id !== bubble.id));

    // Spawn pop particle
    const popId = nextIdRef.current++;
    setPops(prev => [...prev, { id: popId, x: bubble.x, y: bubble.y, emoji: bubble.emoji }]);
    setTimeout(() => setPops(prev => prev.filter(p => p.id !== popId)), 450);

    // Update score
    const newScore = scoreRef.current + 1;
    scoreRef.current = newScore;
    setScore(newScore);

    // Win check
    if (newScore >= configRef.current.target) {
      endGame(true);
    }
  };

  const cfg = DIFF_CONFIG[difficulty];
  const timerPct = (timeLeft / cfg.timeLimit) * 100;
  const timerColor = timerPct > 50 ? '#4ade80' : timerPct > 25 ? '#fbbf24' : '#f87171';

  const diffBucket = statsService.getDifficultyBucket(stats, difficulty);
  const statItems: StatItem[] = [
    { value: diffBucket.wins, label: 'W' },
    { value: diffBucket.losses, label: 'L' },
    { value: diffBucket.draws, label: 'D' },
    { value: diffBucket.winStreak, label: 'Str' },
    { value: `${(diffBucket.winRate * 100).toFixed(0)}%`, label: 'Rate' },
  ];

  return (
    <GamePageShell
      title="PoBabyTouch"
      player={playerName}
      controls={
        <select
          value={difficulty}
          onChange={e => setDifficulty(e.target.value as Difficulty)}
          disabled={phase === 'playing'}
        >
          <option value={Difficulty.Easy}>Easy</option>
          <option value={Difficulty.Medium}>Medium</option>
          <option value={Difficulty.Hard}>Hard</option>
        </select>
      }
      stats={statItems}
      fullscreen
    >
      <div className="pbt-shell">
        {/* Score bar — only during play */}
        {phase === 'playing' && (
          <div className="pbt-scorebar">
            <div className="pbt-score-item">
              <span className="pbt-score-value">{score}</span>
              <span className="pbt-score-label">Popped</span>
            </div>
            <div className="pbt-timer-bar">
              <div
                className="pbt-timer-fill"
                style={{ width: `${timerPct}%`, backgroundColor: timerColor }}
              />
            </div>
            <div className="pbt-score-item">
              <span className="pbt-score-value pbt-score-value--goal">{cfg.target}</span>
              <span className="pbt-score-label">Goal</span>
            </div>
          </div>
        )}

        {/* Play area */}
        <div className="pbt-play-area">
          {/* Bubbles */}
          {bubbles.map(b => (
            <button
              key={b.id}
              className="pbt-bubble"
              style={{
                left: `${b.x}%`,
                top: `${b.y}%`,
                width: b.size,
                height: b.size,
                color: b.color,
                borderColor: b.color,
                backgroundColor: `${b.color}22`,
                animationDuration: `${b.drift}s`,
                animationDelay: `${b.offset}s`,
                transform: `translate(-50%, -50%)`,
              }}
              onClick={() => popBubble(b)}
            >
              {b.emoji}
            </button>
          ))}

          {/* Pop particles */}
          {pops.map(p => (
            <div
              key={p.id}
              className="pbt-pop"
              style={{
                left: `${p.x}%`,
                top: `${p.y}%`,
                transform: 'translate(-50%, -50%)',
              }}
            >
              {p.emoji}
            </div>
          ))}

          {/* Start screen */}
          {phase === 'idle' && (
            <div className="pbt-start-screen">
              <div style={{ fontSize: '4rem' }}>🎈</div>
              <div className="pbt-start-title">PoBabyTouch</div>
              <div className="pbt-start-sub">
                Pop {cfg.target} bubbles in {cfg.timeLimit} seconds!
              </div>
              <button className="pbt-play-btn" onClick={startGame}>
                🎮 Play!
              </button>
            </div>
          )}

          {/* Result overlay */}
          {phase === 'result' && (
            <div className="pbt-result-overlay">
              <div className="pbt-result-emoji">
                {lastResult === GameResult.Win ? '🎉' : '😢'}
              </div>
              <div className="pbt-result-title">
                {lastResult === GameResult.Win ? 'You Win!' : 'Time\'s Up!'}
              </div>
              <div className="pbt-result-sub">
                {lastResult === GameResult.Win
                  ? `Amazing! You popped ${score} bubbles!`
                  : `You popped ${score} / ${cfg.target} bubbles.`}
              </div>
              <button className="pbt-play-btn" onClick={startGame}>
                🔄 Play Again
              </button>
            </div>
          )}
        </div>
      </div>
    </GamePageShell>
  );
}
