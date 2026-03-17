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
  drawGame,
} from './snakeGameEngine';
import type { SnakeMultiplayerWinner } from './useSnakeMultiplayer';

interface MultiplayerSnakeCanvasProps {
  gameState: GameState | null;
  isHost: boolean;
  myPlayerId: string;
  opponentName: string;
  winner: SnakeMultiplayerWinner | null;
  sendDirection: (dir: Direction) => void;
  onPlayAgain: () => void;
  onLeave: () => void;
}

export function MultiplayerSnakeCanvas({
  gameState,
  isHost,
  myPlayerId,
  opponentName,
  winner,
  sendDirection,
  onPlayAgain,
  onLeave,
}: MultiplayerSnakeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const gameStateRef = useRef<GameState | null>(gameState);
  const cellSizeRef = useRef(computeCellSize());
  const [cellSize, setCellSize] = useState(cellSizeRef.current);

  // Keep ref in sync with prop so render loop always reads latest
  gameStateRef.current = gameState;

  // Responsive resize
  useEffect(() => {
    const onResize = () => {
      const s = computeCellSize();
      cellSizeRef.current = s;
      setCellSize(s);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Render loop – just draws; game logic is driven by the hook
  useEffect(() => {
    const render = () => {
      const ctx = canvasRef.current?.getContext('2d');
      const state = gameStateRef.current;
      if (ctx && state) {
        drawGame(ctx, state, cellSizeRef.current);
      }
      animFrameRef.current = requestAnimationFrame(render);
    };
    animFrameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  // Keyboard input
  const applyDirection = useCallback((dir: Direction) => {
    const state = gameStateRef.current;
    if (!state) return;
    const mySnake = state.snakes.find(s => s.isPlayer && s.playerId === myPlayerId);
    if (!mySnake?.isAlive) return;
    if (dir === getOppositeDirection(mySnake.direction)) return;
    sendDirection(dir);
  }, [myPlayerId, sendDirection]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const state = gameStateRef.current;
      if (!state?.isRunning || state.isGameOver) return;
      const mySnake = state.snakes.find(s => s.isPlayer && s.playerId === myPlayerId);
      if (!mySnake?.isAlive) return;

      let dir: Direction | null = null;
      switch (e.key) {
        case 'ArrowUp':    case 'w': case 'W': if (mySnake.direction !== 'down')  dir = 'up'; break;
        case 'ArrowDown':  case 's': case 'S': if (mySnake.direction !== 'up')    dir = 'down'; break;
        case 'ArrowLeft':  case 'a': case 'A': if (mySnake.direction !== 'right') dir = 'left'; break;
        case 'ArrowRight': case 'd': case 'D': if (mySnake.direction !== 'left')  dir = 'right'; break;
      }
      if (dir) { e.preventDefault(); sendDirection(dir); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [myPlayerId, sendDirection]);

  const canvasW = ARENA_WIDTH * cellSize;
  const canvasH = ARENA_HEIGHT * cellSize;

  // Derive HUD values from gameState prop
  const mySnake = gameState?.snakes.find(s => s.isPlayer && s.playerId === myPlayerId);
  const opponentSnake = gameState?.snakes.find(s => s.isPlayer && s.playerId !== myPlayerId);
  const myScore = mySnake?.score ?? 0;
  const opponentScore = opponentSnake?.score ?? 0;
  const myAlive = mySnake?.isAlive ?? true;
  const opponentAlive = opponentSnake?.isAlive ?? true;
  const timeRemaining = gameState?.timeRemaining ?? GAME_DURATION;
  const timePercent = (timeRemaining / GAME_DURATION) * 100;
  const isLowTime = timeRemaining <= 10;
  const playerColor = isHost ? '#00FF00' : '#00FFFF';
  const opponentColor = isHost ? '#00FFFF' : '#00FF00';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
      {/* 2P HUD */}
      <div className="psg-2p-hud">
        {/* My side */}
        <div className="psg-hud-box psg-hud-p1" style={{ borderColor: playerColor }}>
          <span className="psg-hud-label" style={{ color: playerColor }}>You {myAlive ? '' : '💀'}</span>
          <span className="psg-hud-score-val" style={{ color: playerColor }}>{myScore}</span>
        </div>

        {/* Timer in center */}
        <div className="psg-2p-timer-section">
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
          <span className="psg-2p-alive-count">
            {gameState?.snakes.filter(s => s.isAlive).length ?? 0} alive
          </span>
        </div>

        {/* Opponent side */}
        <div className="psg-hud-box psg-hud-p2" style={{ borderColor: opponentColor }}>
          <span className="psg-hud-label" style={{ color: opponentColor }}>{opponentName} {opponentAlive ? '' : '💀'}</span>
          <span className="psg-hud-score-val" style={{ color: opponentColor }}>{opponentScore}</span>
        </div>
      </div>

      {/* Canvas */}
      <div className="psg-canvas-wrap" style={{ position: 'relative' }}>
        <canvas
          ref={canvasRef}
          width={canvasW}
          height={canvasH}
          className="psg-canvas"
        />

        {/* Countdown overlay */}
        {gameState?.countdown != null && gameState.countdown > 0 && (
          <div className="psg-countdown-overlay">
            <span className="psg-countdown-text">{gameState.countdown}</span>
          </div>
        )}

        {/* Winner overlay */}
        {winner != null && (
          <div className="psg-winner-overlay">
            {winner.draw ? (
              <h2 className="psg-winner-title psg-winner-draw">🤝 Draw!</h2>
            ) : winner.userId === myPlayerId ? (
              <h2 className="psg-winner-title psg-winner-win">🏆 You Win!</h2>
            ) : (
              <h2 className="psg-winner-title psg-winner-lose">💀 You Lost</h2>
            )}
            <p className="psg-winner-desc">
              {winner.draw ? `Both snakes died simultaneously` : `${winner.displayName} survived with ${winner.score} pts`}
            </p>
            <div className="psg-winner-buttons">
              <button className="psg-new-game-btn" onClick={onPlayAgain}>
                Play Again
              </button>
              <button
                className="psg-btn-secondary"
                onClick={onLeave}
              >
                Leave
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Keyboard hint */}
      <div className="psg-kbd-hint">
        <kbd>WASD</kbd> or <kbd>Arrow Keys</kbd> to move
      </div>

      {/* D-Pad (mobile) */}
      <TouchControls onDirection={applyDirection} />
    </div>
  );
}
