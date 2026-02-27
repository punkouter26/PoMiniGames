import { useCallback, useEffect, useRef, useState } from 'react';
import { TouchControls } from './TouchControls';

// ── Types ─────────────────────────────────────────────────────────────────
export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Position {
  x: number;
  y: number;
}

export interface Snake {
  segments: Position[];
  direction: Direction;
  color: string;
  isAlive: boolean;
  score: number;
  isPlayer: boolean;
}

export interface GameState {
  snakes: Snake[];
  foods: Position[];
  arenaWidth: number;
  arenaHeight: number;
  timeRemaining: number;
  isRunning: boolean;
  isGameOver: boolean;
  countdown: number | null;
}

// ── Constants ─────────────────────────────────────────────────────────────
const ARENA_WIDTH = 48;
const ARENA_HEIGHT = 32;
const GAME_DURATION = 30;
const CPU_COUNT = 15;
const INITIAL_FOOD_COUNT = 20;

const PERSONALITY_COLORS = [
  '#808080', // Random  - Gray
  '#FFFF00', // Foodie  - Yellow
  '#00FFFF', // Cautious - Cyan
  '#00BFFF', // Survivor - Deep Sky Blue
  '#FFA500', // Speedy  - Orange
  '#800080', // Aggressive - Purple
];

function computeCellSize(): number {
  const maxW = Math.min(window.innerWidth - 32, 960);
  const maxH = window.innerHeight - 200;
  const cellW = Math.floor(maxW / ARENA_WIDTH);
  const cellH = Math.floor(maxH / ARENA_HEIGHT);
  return Math.max(8, Math.min(cellW, cellH, 20));
}

interface ScorePop {
  id: number;
  x: number;
  y: number;
}

interface GameCanvasProps {
  onGameOver: (score: number, snakeLength: number, foodEaten: number) => void;
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

  const createPosition = (x: number, y: number): Position => ({ x, y });

  const getDirectionDelta = (direction: Direction): Position => {
    switch (direction) {
      case 'up':    return { x: 0, y: -1 };
      case 'down':  return { x: 0, y: 1 };
      case 'left':  return { x: -1, y: 0 };
      case 'right': return { x: 1, y: 0 };
    }
  };

  const getOppositeDirection = (direction: Direction): Direction => {
    switch (direction) {
      case 'up':    return 'down';
      case 'down':  return 'up';
      case 'left':  return 'right';
      case 'right': return 'left';
    }
  };

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

  const initializeGame = useCallback((): GameState => {
    const snakes: Snake[] = [];
    const foods: Position[] = [];

    snakes.push({
      segments: [createPosition(Math.floor(ARENA_WIDTH / 8), Math.floor(ARENA_HEIGHT / 2))],
      direction: 'right',
      color: '#00FF00',
      isAlive: true,
      score: 0,
      isPlayer: true,
    });

    for (let i = 0; i < CPU_COUNT; i++) {
      const x = Math.floor(ARENA_WIDTH * 0.6) + Math.floor(Math.random() * (ARENA_WIDTH * 0.35));
      const y = Math.floor(Math.random() * ARENA_HEIGHT);
      const dirs: Direction[] = ['up', 'down', 'left', 'right'];
      snakes.push({
        segments: [createPosition(x, y)],
        direction: dirs[Math.floor(Math.random() * 4)]!,
        color: PERSONALITY_COLORS[i % PERSONALITY_COLORS.length]!,
        isAlive: true,
        score: 0,
        isPlayer: false,
      });
    }

    for (let i = 0; i < INITIAL_FOOD_COUNT; i++) {
      foods.push(createPosition(
        Math.floor(Math.random() * ARENA_WIDTH),
        Math.floor(Math.random() * ARENA_HEIGHT),
      ));
    }

    return {
      snakes,
      foods,
      arenaWidth: ARENA_WIDTH,
      arenaHeight: ARENA_HEIGHT,
      timeRemaining: GAME_DURATION,
      isRunning: false,
      isGameOver: false,
      countdown: 3,
    };
  }, []);

  const updateCPUSnake = (snake: Snake, state: GameState): Direction => {
    const head = snake.segments[0]!;
    const validDirs = (['up', 'down', 'left', 'right'] as Direction[]).filter(
      d => d !== getOppositeDirection(snake.direction),
    );

    let nearest: Position | null = null;
    let nearestDist = Infinity;
    for (const food of state.foods) {
      const d = Math.abs(food.x - head.x) + Math.abs(food.y - head.y);
      if (d < nearestDist) { nearestDist = d; nearest = food; }
    }

    if (nearest && Math.random() > 0.3) {
      const dx = nearest.x - head.x;
      const dy = nearest.y - head.y;
      const pref: Direction[] = [];
      if (dx > 0 && validDirs.includes('right')) pref.push('right');
      if (dx < 0 && validDirs.includes('left'))  pref.push('left');
      if (dy > 0 && validDirs.includes('down'))  pref.push('down');
      if (dy < 0 && validDirs.includes('up'))    pref.push('up');
      if (pref.length > 0) return pref[Math.floor(Math.random() * pref.length)]!;
    }

    return validDirs[Math.floor(Math.random() * validDirs.length)]!;
  };

  const updateGame = useCallback((state: GameState): GameState => {
    if (!state.isRunning || state.isGameOver) return state;

    const newSnakes = state.snakes.map(snake => {
      if (!snake.isAlive) return snake;

      if (!snake.isPlayer) {
        snake.direction = updateCPUSnake(snake, state);
      }

      const head = snake.segments[0]!
      const delta = getDirectionDelta(snake.direction);
      const newHead = createPosition(head.x + delta.x, head.y + delta.y);

      if (newHead.x < 0 || newHead.x >= state.arenaWidth ||
          newHead.y < 0 || newHead.y >= state.arenaHeight) {
        return { ...snake, isAlive: false };
      }
      if (snake.segments.some(s => s.x === newHead.x && s.y === newHead.y)) {
        return { ...snake, isAlive: false };
      }
      for (const other of state.snakes) {
        if (other === snake || !other.isAlive) continue;
        if (other.segments.some(s => s.x === newHead.x && s.y === newHead.y)) {
          return { ...snake, isAlive: false };
        }
      }

      const newSegments = [newHead, ...snake.segments];
      const foodIdx = state.foods.findIndex(f => f.x === newHead.x && f.y === newHead.y);
      if (foodIdx >= 0) {
        state.foods.splice(foodIdx, 1);
        state.foods.push(createPosition(
          Math.floor(Math.random() * state.arenaWidth),
          Math.floor(Math.random() * state.arenaHeight),
        ));
        return { ...snake, segments: newSegments, score: snake.score + 10 };
      } else {
        newSegments.pop();
        return { ...snake, segments: newSegments };
      }
    });

    const player = newSnakes.find(s => s.isPlayer);
    const isGameOver = !player?.isAlive || state.timeRemaining <= 0;
    return { ...state, snakes: newSnakes, isGameOver };
  }, []);

  const drawGame = useCallback((ctx: CanvasRenderingContext2D, state: GameState) => {
    const cs = cellSizeRef.current;
    const canvasW = ARENA_WIDTH * cs;
    const canvasH = ARENA_HEIGHT * cs;

    ctx.fillStyle = '#0f0f1a';
    ctx.fillRect(0, 0, canvasW, canvasH);

    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= ARENA_WIDTH; x++) {
      ctx.beginPath(); ctx.moveTo(x * cs, 0); ctx.lineTo(x * cs, canvasH); ctx.stroke();
    }
    for (let y = 0; y <= ARENA_HEIGHT; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * cs); ctx.lineTo(canvasW, y * cs); ctx.stroke();
    }

    for (const food of state.foods) {
      const cx = food.x * cs + cs / 2;
      const cy = food.y * cs + cs / 2;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, cs * 0.8);
      grad.addColorStop(0, 'rgba(255, 107, 107, 0.4)');
      grad.addColorStop(1, 'rgba(255, 107, 107, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(food.x * cs - cs * 0.3, food.y * cs - cs * 0.3, cs * 1.6, cs * 1.6);
      ctx.fillStyle = '#ff6b6b';
      ctx.beginPath();
      ctx.arc(cx, cy, cs / 3, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const snake of state.snakes) {
      if (!snake.isAlive) continue;
      for (let i = 0; i < snake.segments.length; i++) {
        const seg = snake.segments[i]!;
        const isHead = i === 0;

        if (snake.isPlayer && isHead) {
          ctx.shadowColor = '#00FF00'; ctx.shadowBlur = cs * 0.6;
          ctx.fillStyle = '#00FF00';
          ctx.fillRect(seg.x * cs + 0.5, seg.y * cs + 0.5, cs - 1, cs - 1);
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#ffffff';
          const dotR = Math.max(1, cs * 0.12);
          ctx.beginPath(); ctx.arc(seg.x * cs + cs * 0.35, seg.y * cs + cs * 0.4, dotR, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(seg.x * cs + cs * 0.65, seg.y * cs + cs * 0.4, dotR, 0, Math.PI * 2); ctx.fill();
        } else if (snake.isPlayer) {
          ctx.fillStyle = '#00DD00';
          ctx.fillRect(seg.x * cs + 1.5, seg.y * cs + 1.5, cs - 3, cs - 3);
        } else if (isHead) {
          ctx.fillStyle = snake.color;
          ctx.fillRect(seg.x * cs + 1, seg.y * cs + 1, cs - 2, cs - 2);
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.beginPath(); ctx.arc(seg.x * cs + cs / 2, seg.y * cs + cs / 2, Math.max(1, cs * 0.12), 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillStyle = snake.color;
          ctx.globalAlpha = 0.7;
          ctx.fillRect(seg.x * cs + 2, seg.y * cs + 2, cs - 4, cs - 4);
          ctx.globalAlpha = 1;
        }
      }
    }

    if (state.countdown !== null && state.countdown > 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(0, 0, canvasW, canvasH);
      ctx.fillStyle = '#00FF00';
      ctx.font = `bold ${Math.round(cs * 5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = '#00FF00'; ctx.shadowBlur = 30;
      ctx.fillText(state.countdown.toString(), canvasW / 2, canvasH / 2);
      ctx.shadowBlur = 0;
    }
  }, []);

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
        if (p) onGameOver(p.score, p.segments.length, Math.floor(p.score / 10));
        return;
      }
    }

    const ctx = canvasRef.current?.getContext('2d');
    if (ctx && gameStateRef.current) drawGame(ctx, gameStateRef.current);

    animationFrameRef.current = requestAnimationFrame(gameLoop);
  }, [drawGame, onGameOver, updateGame]);

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
  }, [gameLoop, handleKeyDown, initializeGame]);

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
