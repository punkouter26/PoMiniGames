import { useCallback, useEffect, useRef, useState } from 'react';
import { TouchControls } from './TouchControls';
import {
  type Direction,
  type GameState,
  ARENA_WIDTH,
  ARENA_HEIGHT,
  GAME_DURATION,
  computeCellSize,
  getOppositeDirection,
  initializeGame,
  updateGame,
  drawGame,
} from './snakeGameEngine';

interface ScorePop {
  id: number;
  x: number;
  y: number;
}

interface GameCanvasProps {
  onGameOver: (score: number, snakeLength: number, foodEaten: number, gameDuration: number) => void;
}

export function GameCanvas({ onGameOver }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameStateRef = useRef<GameState | null>(null);
  const animationFrameRef = useRef<number>(0);
  const lastUpdateRef = useRef<number>(0);
  const cellSizeRef = useRef(computeCellSize());

  const [_gameState, setGameState] = useState<GameState | null>(null);
  const [score, setScore] = useState(0);
  const [prevScore, setPrevScore] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(GAME_DURATION);
  const [cellSize, setCellSize] = useState(cellSizeRef.current);
  const [scorePops, setScorePops] = useState<ScorePop[]>([]);
  const popIdRef = useRef(0);

  // Responsive resize
  useEffect(() => {
    const onResize = () => {
      const newSize = computeCellSize();
      cellSizeRef.current = newSize;
      setCellSize(newSize);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Score pop effect
  useEffect(() => {
    if (score > prevScore && gameStateRef.current) {
      const player = gameStateRef.current.snakes.find(s => s.isPlayer);
      if (player) {
        const head = player.segments[0]!;
        const id = ++popIdRef.current;
        setScorePops(prev => [...prev, { id, x: head.x * cellSizeRef.current, y: head.y * cellSizeRef.current }]);
        setTimeout(() => setScorePops(prev => prev.filter(p => p.id !== id)), 800);
      }
    }
    setPrevScore(score);
  }, [score, prevScore]);

  const gameLoop = useCallback((timestamp: number) => {
    if (!gameStateRef.current) return;

    const elapsed = timestamp - lastUpdateRef.current;
    if (elapsed > 100) {
      lastUpdateRef.current = timestamp;
      let state = gameStateRef.current;

      if (state.countdown !== null && state.countdown > 0) {
        state = { ...state, countdown: state.countdown - 1 };
        if (state.countdown === 0) state = { ...state, isRunning: true, countdown: null };
      } else if (state.isRunning && !state.isGameOver) {
        state = updateGame(state);
        state = { ...state, timeRemaining: state.timeRemaining - 0.1 };
        if (state.timeRemaining <= 0) state = { ...state, isGameOver: true };
      }

      gameStateRef.current = state;
      setGameState(state);

      const player = state.snakes.find(s => s.isPlayer);
      if (player) setScore(player.score);
      setTimeRemaining(Math.max(0, state.timeRemaining));

      if (state.isGameOver) {
        const p = state.snakes.find(s => s.isPlayer);
        if (p) {
          const gameDuration = parseFloat((GAME_DURATION - Math.max(0, state.timeRemaining)).toFixed(1));
          onGameOver(p.score, p.segments.length, p.foodEaten, gameDuration);
        }
        return;
      }
    }

    const ctx = canvasRef.current?.getContext('2d');
    if (ctx && gameStateRef.current) drawGame(ctx, gameStateRef.current, cellSizeRef.current);

    animationFrameRef.current = requestAnimationFrame(gameLoop);
  }, [onGameOver]);

  const applyDirection = useCallback((newDirection: Direction) => {
    if (!gameStateRef.current) return;
    const state = gameStateRef.current;
    const player = state.snakes.find(s => s.isPlayer);
    if (!player?.isAlive) return;
    if (newDirection === getOppositeDirection(player.direction)) return;
    gameStateRef.current = {
      ...state,
      snakes: state.snakes.map(s => s.isPlayer ? { ...s, direction: newDirection } : s),
    };
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!gameStateRef.current) return;
    const player = gameStateRef.current.snakes.find(s => s.isPlayer);
    if (!player?.isAlive) return;

    let dir: Direction | null = null;
    switch (e.key) {
      case 'ArrowUp':    case 'w': case 'W': if (player.direction !== 'down')  dir = 'up';    break;
      case 'ArrowDown':  case 's': case 'S': if (player.direction !== 'up')    dir = 'down';  break;
      case 'ArrowLeft':  case 'a': case 'A': if (player.direction !== 'right') dir = 'left';  break;
      case 'ArrowRight': case 'd': case 'D': if (player.direction !== 'left')  dir = 'right'; break;
    }
    if (dir) { e.preventDefault(); applyDirection(dir); }
  }, [applyDirection]);

  useEffect(() => {
    const state = initializeGame();
    gameStateRef.current = state;
    setGameState(state);
    window.addEventListener('keydown', handleKeyDown);
    lastUpdateRef.current = performance.now();
    animationFrameRef.current = requestAnimationFrame(gameLoop);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      cancelAnimationFrame(animationFrameRef.current);
    };
  }, [gameLoop, handleKeyDown]);

  const canvasW = ARENA_WIDTH * cellSize;
  const canvasH = ARENA_HEIGHT * cellSize;
  const timePercent = (timeRemaining / GAME_DURATION) * 100;
  const isLowTime = timeRemaining <= 10;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
      {/* HUD */}
      <div className="psg-hud" style={{ maxWidth: canvasW }}>
        <div className="psg-hud-box">
          <span className="psg-hud-label">Score</span>
          <span className="psg-hud-score-val">{score}</span>
        </div>

        <div className="psg-timer-bar-wrap">
          <div
            className={`psg-timer-bar-fill${isLowTime ? ' psg-low-time' : ''}`}
            style={{ width: `${timePercent}%` }}
          />
          <div className="psg-timer-bar-text">
            <span className={`psg-hud-time-val${isLowTime ? ' psg-low-time' : ''}`}>
              {timeRemaining.toFixed(1)}s
            </span>
          </div>
        </div>

        <div className="psg-hud-box">
          <span className="psg-hud-label">Alive</span>
          <span className="psg-hud-alive-val">
            {gameStateRef.current ? gameStateRef.current.snakes.filter(s => s.isAlive).length : 0}
          </span>
        </div>
      </div>

      {/* Canvas */}
      <div className="psg-canvas-wrap">
        <canvas
          ref={canvasRef}
          width={canvasW}
          height={canvasH}
          className="psg-canvas"
        />
        {scorePops.map(p => (
          <span
            key={p.id}
            className="psg-score-pop"
            style={{ left: p.x, top: p.y, fontSize: cellSize * 1.2 }}
          >
            +10
          </span>
        ))}
      </div>

      {/* Keyboard hint (desktop) */}
      <div className="psg-kbd-hint">
        <kbd>WASD</kbd> or <kbd>Arrow Keys</kbd> to move
      </div>

      {/* D-Pad (mobile) */}
      <TouchControls onDirection={applyDirection} />
    </div>
  );
}
