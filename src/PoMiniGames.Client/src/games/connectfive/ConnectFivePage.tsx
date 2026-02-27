import { useState, useCallback } from 'react';
import { Piece, Difficulty, GameResult } from '../shared/types';
import { statsService } from '../shared/statsService';
import { ConnectFiveBoard } from './ConnectFiveBoard';
import { ConnectFiveAI } from './ConnectFiveAI';
import { usePlayerName } from '../../context/PlayerNameContext';
import { GamePageShell, type StatItem } from '../shared/GamePageShell';
import { CircleDot, Circle, RotateCcw, Loader2, Trophy, Users } from 'lucide-react';
import './ConnectFivePage.css';

const GAME_KEY = 'connectfive';

export default function ConnectFivePage() {
  const { playerName } = usePlayerName();
  const [board, setBoard] = useState(() => new ConnectFiveBoard());
  const [difficulty, setDifficulty] = useState(Difficulty.Medium);
  const [gameResult, setGameResult] = useState(GameResult.InProgress);
  const [winCells, setWinCells] = useState<[number, number][]>([]);
  const [isAiTurn, setIsAiTurn] = useState(false);
  const [stats, setStats] = useState(() => statsService.getStats(GAME_KEY, playerName));
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);

  const resetGame = useCallback(() => {
    setBoard(new ConnectFiveBoard());
    setGameResult(GameResult.InProgress);
    setWinCells([]);
    setIsAiTurn(false);
  }, []);

  const handleDrop = useCallback(
    (col: number) => {
      if (gameResult !== GameResult.InProgress || isAiTurn) return;
      if (board.getTargetRow(col) < 0) return;

      // Player drop
      let next = board.drop(col, Piece.Red);

      const playerWin = next.checkWin(Piece.Red);
      if (playerWin.won) {
        setBoard(next);
        setGameResult(GameResult.Win);
        setWinCells(playerWin.cells);
        statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Win)
          .then(setStats);
        return;
      }

      if (next.isFull()) {
        setBoard(next);
        setGameResult(GameResult.Draw);
        statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Draw)
          .then(setStats);
        return;
      }

      // AI drop
      setBoard(next);
      setIsAiTurn(true);

      setTimeout(() => {
        const aiCol = ConnectFiveAI.getMove(next, Piece.Yellow, difficulty);
        next = next.drop(aiCol, Piece.Yellow);

        const aiWin = next.checkWin(Piece.Yellow);
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
      }, 250);
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
          : { icon: <CircleDot size={14} color="#f44336" />, text: 'Your turn (Red)', className: 'turn' };
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
      title={<><CircleDot size={14} color="#f44336" /> Connect Five</>}
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
      {/* Column drop buttons */}
      <div className="cf-drop-row">
        {Array.from({ length: ConnectFiveBoard.Cols }, (_, c) => (
          <button
            key={c}
            className={`cf-drop-btn ${hoveredCol === c && gameResult === GameResult.InProgress && !isAiTurn ? 'active-column' : ''}`}
            disabled={gameResult !== GameResult.InProgress || isAiTurn || board.getTargetRow(c) < 0}
            onClick={() => handleDrop(c)}
            onMouseEnter={() => setHoveredCol(c)}
            onMouseLeave={() => setHoveredCol(null)}
            aria-label={`Drop piece in column ${c + 1}`}
          >
            ▼
          </button>
        ))}
      </div>

      {/* Board grid */}
      <div 
        className="cf-board" 
        role="grid" 
        aria-label="Connect Five game board"
      >
        {Array.from({ length: ConnectFiveBoard.Rows }, (_, r) =>
          Array.from({ length: ConnectFiveBoard.Cols }, (_, c) => {
            const piece = board.get(r, c);
            const cls = [
              'cf-cell',
              piece === Piece.Red ? 'red' : piece === Piece.Yellow ? 'yellow' : '',
              isWinCell(r, c) ? 'win-cell' : '',
              gameResult !== GameResult.InProgress ? 'disabled' : '',
            ].filter(Boolean).join(' ');
            return (
              <div 
                key={`${r}-${c}`} 
                className={cls} 
                onClick={() => handleDrop(c)}
                onMouseEnter={() => setHoveredCol(c)}
                onMouseLeave={() => setHoveredCol(null)}
                role="gridcell"
                aria-label={piece === Piece.Red ? 'Red piece' : piece === Piece.Yellow ? 'Yellow piece' : 'Empty cell'}
              >
                {piece === Piece.Red && (
                  <Circle size={28} className="piece" stroke="none" fill="#f44336"
                    style={{ '--drop-rows': r + 1 } as React.CSSProperties} />
                )}
                {piece === Piece.Yellow && (
                  <Circle size={28} className="piece" stroke="none" fill="#ffeb3b"
                    style={{ '--drop-rows': r + 1 } as React.CSSProperties} />
                )}
              </div>
            );
          }),
        )}
      </div>
    </GamePageShell>
  );
}
