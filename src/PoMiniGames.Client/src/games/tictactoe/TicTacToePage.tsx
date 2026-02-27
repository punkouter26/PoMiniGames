import { useState, useCallback } from 'react';
import { CellValue, Difficulty, GameResult } from '../shared/types';
import { statsService } from '../shared/statsService';
import { TicTacToeBoard } from './TicTacToeBoard';
import { TicTacToeAI } from './TicTacToeAI';
import { usePlayerName } from '../../context/PlayerNameContext';
import { GamePageShell, type StatItem } from '../shared/GamePageShell';
import { CircleDot, X, RotateCcw, Loader2, Trophy, Users } from 'lucide-react';
import './TicTacToePage.css';

const GAME_KEY = 'tictactoe';

export default function TicTacToePage() {
  const { playerName } = usePlayerName();
  const [board, setBoard] = useState(() => new TicTacToeBoard());
  const [difficulty, setDifficulty] = useState(Difficulty.Medium);
  const [gameResult, setGameResult] = useState(GameResult.InProgress);
  const [winCells, setWinCells] = useState<[number, number][]>([]);
  const [isAiTurn, setIsAiTurn] = useState(false);
  const [stats, setStats] = useState(() => statsService.getStats(GAME_KEY, playerName));

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
        return { icon: <Trophy size={14} />, text: 'You Win!', className: 'win' };
      case GameResult.Loss:
        return { icon: <CircleDot size={14} />, text: 'AI Wins!', className: 'loss' };
      case GameResult.Draw:
        return { icon: <Users size={14} />, text: 'Draw!', className: 'draw' };
      default:
        return isAiTurn
          ? { icon: <Loader2 size={14} className="thinking-indicator" />, text: 'AI thinking...', className: 'thinking' }
          : { icon: <X size={14} />, text: 'Your turn (X)', className: 'turn' };
    }
  };

  const status = getStatusContent();
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
      title={<><X size={14} color="#ff5252" strokeWidth={2.5} /> Tic Tac Toe</>}
      player={playerName}
      status={
        <span className={`gps-status-badge ${status.className}`}>
          {status.icon} {status.text}
        </span>
      }
      controls={
        <>
          <select
            value={difficulty}
            onChange={(e) => { setDifficulty(e.target.value as Difficulty); resetGame(); }}
            aria-label="Select difficulty"
          >
            <option value={Difficulty.Easy}>Easy</option>
            <option value={Difficulty.Medium}>Medium</option>
            <option value={Difficulty.Hard}>Hard</option>
          </select>
          <button onClick={resetGame}>
            <RotateCcw size={12} /> New Game
          </button>
        </>
      }
      stats={statItems}
    >
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
    </GamePageShell>
  );
}
