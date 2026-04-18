import { CircleDot, RotateCcw, X } from 'lucide-react';
import { CellValue, Difficulty, GameResult } from '../shared/types';
import { GamePageShell } from '../shared/GamePageShell';
import { TicTacToeBoard } from './TicTacToeBoard';
import { useTicTacToeGame } from './useTicTacToeGame';
import './TicTacToePage.css';

export default function TicTacToePage() {
  const {
    boardToRender,
    difficulty,
    setDifficulty,
    gameResult,
    isAiTurn,
    playMode,
    setPlayMode,
    resetGame,
    handleCellClick,
    isWinCell,
    status,
    statItems,
    playerName,
  } = useTicTacToeGame();

  const backTo = playMode === 'local'
    ? '/multi-player-select'
    : playMode === 'demo'
      ? '/single-player?mode=demo'
      : '/single-player';

  return (
    <GamePageShell
      title={<><X size={14} color="#ff5252" strokeWidth={2.5} /> Tic Tac Toe</>}
      player={playerName}
      backTo={backTo}
      gameOver={gameResult !== GameResult.InProgress && playMode !== 'demo'}
      onPlayAgain={resetGame}
      status={
        <span className={`gps-status-badge ${status.className}`}>
          {status.icon} {status.text}
        </span>
      }
      controls={
        <>
          <button type="button" aria-pressed={playMode === 'ai'} onClick={() => { setPlayMode('ai'); resetGame(); }}>
            Vs AI
          </button>
          <button type="button" aria-pressed={playMode === 'local'} onClick={() => { setPlayMode('local'); resetGame(); }}>
            Local 2P
          </button>
          <button type="button" aria-pressed={playMode === 'demo'} onClick={() => { setPlayMode('demo'); resetGame(); }}>
            Demo CPU vs CPU
          </button>
          {playMode === 'local' ? (
            <button onClick={resetGame}><RotateCcw size={12} /> New Local Game</button>
          ) : (
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
              <button onClick={resetGame}><RotateCcw size={12} /> {playMode === 'demo' ? 'Restart Demo' : 'New Game'}</button>
            </>
          )}
        </>
      }
      stats={statItems}
    >
      <div className="ttt-board" role="grid" aria-label="Tic Tac Toe game board">
        {Array.from({ length: TicTacToeBoard.Size }, (_, r) =>
          Array.from({ length: TicTacToeBoard.Size }, (_, c) => {
            const val = boardToRender.get(r, c);
            const disabled = playMode === 'demo'
              ? true
              : gameResult !== GameResult.InProgress || isAiTurn || val !== CellValue.None;
            return (
              <div
                key={`${r}-${c}`}
                className={`ttt-cell${disabled ? ' disabled' : ''}${isWinCell(r, c) ? ' win-cell' : ''}`}
                onClick={() => handleCellClick(r, c)}
                role="gridcell"
                aria-label={val === CellValue.X ? 'X' : val === CellValue.O ? 'O' : 'Empty cell'}
                tabIndex={disabled ? -1 : 0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleCellClick(r, c); }}
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

