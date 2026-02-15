import { useState, useCallback, useEffect } from 'react';
import { CellValue, Difficulty, GameResult } from '../shared/types';
import { statsService } from '../shared/statsService';
import { TicTacToeBoard } from './TicTacToeBoard';
import { TicTacToeAI } from './TicTacToeAI';
import { CircleDot, X, RotateCcw, Loader2, Trophy, Users, BarChart3 } from 'lucide-react';
import './TicTacToePage.css';

const GAME_KEY = 'tictactoe';

export default function TicTacToePage() {
  const [board, setBoard] = useState(() => new TicTacToeBoard());
  const [difficulty, setDifficulty] = useState(Difficulty.Medium);
  const [playerName, setPlayerName] = useState(() => localStorage.getItem('pomini_player') ?? 'Player');
  const [gameResult, setGameResult] = useState(GameResult.InProgress);
  const [winCells, setWinCells] = useState<[number, number][]>([]);
  const [isAiTurn, setIsAiTurn] = useState(false);
  const [stats, setStats] = useState(() => statsService.getStats(GAME_KEY, playerName));
  const [showStats, setShowStats] = useState(true);

  // Persist player name
  useEffect(() => { localStorage.setItem('pomini_player', playerName); }, [playerName]);

  // Refresh stats when name changes
  useEffect(() => { setStats(statsService.getStats(GAME_KEY, playerName)); }, [playerName]);

  const resetGame = useCallback(() => {
    setBoard(new TicTacToeBoard());
    setGameResult(GameResult.InProgress);
    setWinCells([]);
    setIsAiTurn(false);
  }, []);

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (gameResult !== GameResult.InProgress || isAiTurn) return;
      if (board.get(row, col) !== CellValue.None) return;

      // Player move
      let next = board.place(row, col, CellValue.X);

      // Check player win
      const playerWin = next.checkWin(CellValue.X);
      if (playerWin.won) {
        setBoard(next);
        setGameResult(GameResult.Win);
        setWinCells(playerWin.cells);
        statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Win)
          .then(setStats);
        return;
      }

      // Check draw
      if (next.isFull()) {
        setBoard(next);
        setGameResult(GameResult.Draw);
        statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Draw)
          .then(setStats);
        return;
      }

      // AI move
      setBoard(next);
      setIsAiTurn(true);

      setTimeout(() => {
        const [ar, ac] = TicTacToeAI.getMove(next, CellValue.O, difficulty);
        next = next.place(ar, ac, CellValue.O);

        const aiWin = next.checkWin(CellValue.O);
        if (aiWin.won) {
          setBoard(next);
          setGameResult(GameResult.Loss);
          setWinCells(aiWin.cells);
          setIsAiTurn(false);
          statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Loss)
            .then(setStats);
          return;
        }

        if (next.isFull()) {
          setBoard(next);
          setGameResult(GameResult.Draw);
          setIsAiTurn(false);
          statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Draw)
            .then(setStats);
          return;
        }

        setBoard(next);
        setIsAiTurn(false);
      }, 200);
    },
    [board, gameResult, isAiTurn, difficulty, playerName],
  );

  const isWinCell = (r: number, c: number) =>
    winCells.some(([wr, wc]) => wr === r && wc === c);

  const getStatusContent = () => {
    switch (gameResult) {
      case GameResult.Win: 
        return { icon: <Trophy size={24} />, text: 'You Win!', className: 'win' };
      case GameResult.Loss: 
        return { icon: <CircleDot size={24} />, text: 'AI Wins!', className: 'loss' };
      case GameResult.Draw: 
        return { icon: <Users size={24} />, text: 'Draw!', className: 'draw' };
      default: 
        return isAiTurn 
          ? { icon: <Loader2 size={24} className="thinking-indicator" />, text: 'AI is thinking...', className: 'thinking' }
          : { icon: <X size={24} />, text: 'Your turn (X)', className: 'turn' };
    }
  };

  const status = getStatusContent();

  const diffBucket = statsService.getDifficultyBucket(stats, difficulty);

  return (
    <div>
      <div className="game-header">
        <h1>
          <span className="game-icon">
            <X size={28} color="#ff5252" strokeWidth={2.5} />
            <CircleDot size={28} stroke="none" fill="#ffc107" />
          </span>
          Tic Tac Toe
        </h1>
      </div>

      <div className="game-controls">
        <label>
          <Users size={16} />
          Name:
          <input
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value || 'Player')}
            aria-label="Player name"
          />
        </label>
        <label>
          <BarChart3 size={16} />
          Difficulty:
          <select
            value={difficulty}
            onChange={(e) => { setDifficulty(e.target.value as Difficulty); resetGame(); }}
            aria-label="Select difficulty"
          >
            <option value={Difficulty.Easy}>Easy</option>
            <option value={Difficulty.Medium}>Medium</option>
            <option value={Difficulty.Hard}>Hard</option>
          </select>
        </label>
        <button onClick={resetGame}>
          <RotateCcw size={16} />
          New Game
        </button>
      </div>

      <div className={`game-status ${status.className}`}>
        <span className="status-icon">{status.icon}</span>
        <span>{status.text}</span>
      </div>

      <div 
        className="ttt-board" 
        role="grid" 
        aria-label="Tic Tac Toe game board"
      >
        {Array.from({ length: TicTacToeBoard.Size }, (_, r) =>
          Array.from({ length: TicTacToeBoard.Size }, (_, c) => {
            const val = board.get(r, c);
            const disabled = gameResult !== GameResult.InProgress || isAiTurn || val !== CellValue.None;
            return (
              <div
                key={`${r}-${c}`}
                className={`ttt-cell${disabled ? ' disabled' : ''}${isWinCell(r, c) ? ' win-cell' : ''}`}
                onClick={() => handleCellClick(r, c)}
                role="gridcell"
                aria-label={val === CellValue.X ? 'X' : val === CellValue.O ? 'O' : 'Empty cell'}
                tabIndex={disabled ? -1 : 0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    handleCellClick(r, c);
                  }
                }}
              >
                {val === CellValue.X && <X size={28} className="piece" strokeWidth={2.5} />}
                {val === CellValue.O && <CircleDot size={28} className="piece" stroke="none" fill="#ffc107" />}
              </div>
            );
          }),
        )}
      </div>

      <div className={`stats-panel ${showStats ? '' : 'collapsed'}`} onClick={() => setShowStats(!showStats)}>
        <div className="stats-panel-header">
          <h3>
            <BarChart3 size={18} />
            {playerName}'s Stats ({difficulty})
          </h3>
          <span className="stats-panel-toggle">▼</span>
        </div>
        <div className="stats-panel-content">
          <div className="stats-grid">
            <div className="stat-item">
              <div className="stat-value">{diffBucket.wins}</div>
              <div className="stat-label">Wins</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{diffBucket.losses}</div>
              <div className="stat-label">Losses</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{diffBucket.draws}</div>
              <div className="stat-label">Draws</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{diffBucket.totalGames}</div>
              <div className="stat-label">Total</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{diffBucket.winStreak}</div>
              <div className="stat-label">Streak</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{(diffBucket.winRate * 100).toFixed(0)}%</div>
              <div className="stat-label">Win Rate</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
