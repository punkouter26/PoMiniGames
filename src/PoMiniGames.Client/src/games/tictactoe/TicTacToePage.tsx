import { CircleDot, RotateCcw, Users, X } from 'lucide-react';
import { CellValue, Difficulty, GameResult } from '../shared/types';
import { GamePageShell } from '../shared/GamePageShell';
import { TicTacToeBoard } from './TicTacToeBoard';
import { useTicTacToeGame } from './useTicTacToeGame';
import './TicTacToePage.css';

export default function TicTacToePage() {
  const {
    boardToRender, difficulty, setDifficulty, gameResult, isAiTurn,
    playMode, setPlayMode, resetGame, handleCellClick, isWinCell,
    opponent, isMyTurnOnline, status, statItems, multiplayer,
    isAuthenticated, isConfigured, signIn, playerName,
  } = useTicTacToeGame();

  return (
    <GamePageShell
      title={<><X size={14} color="#ff5252" strokeWidth={2.5} /> Tic Tac Toe</>}
      player={playerName}
      backTo="/"
      status={
        <span className={`gps-status-badge ${status.className}`}>
          {status.icon} {status.text}
        </span>
      }
      controls={
        <>
          <button
            type="button"
            aria-pressed={playMode === 'ai'}
            onClick={() => {
              if (playMode === 'online' && multiplayer.match) void multiplayer.leaveMatch();
              setPlayMode('ai');
              resetGame();
            }}
          >
            Vs AI
          </button>
          <button
            type="button"
            aria-pressed={playMode === 'online'}
            onClick={() => {
              if (playMode === 'demo') resetGame();
              setPlayMode('online');
            }}
          >
            Online 2P
          </button>
          <button
            type="button"
            aria-pressed={playMode === 'demo'}
            onClick={() => {
              if (playMode === 'online' && multiplayer.match) void multiplayer.leaveMatch();
              setPlayMode('demo');
              resetGame();
            }}
          >
            Demo CPU vs CPU
          </button>
          {playMode === 'ai' ? (
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
              <button onClick={resetGame}><RotateCcw size={12} /> New Game</button>
            </>
          ) : playMode === 'demo' ? (
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
              <button onClick={resetGame}><RotateCcw size={12} /> Restart Demo</button>
            </>
          ) : !isConfigured ? null : !isAuthenticated ? (
            <button onClick={() => void signIn()}><Users size={12} /> Sign In</button>
          ) : multiplayer.match ? (
            <button onClick={() => void multiplayer.leaveMatch()}><RotateCcw size={12} /> Leave Match</button>
          ) : (
            <button onClick={() => void multiplayer.joinQueue()} disabled={multiplayer.isBusy}>
              <Users size={12} /> Find Opponent
            </button>
          )}
        </>
      }
      stats={statItems}
    >
      {playMode === 'online' && opponent && (
        <div style={{ marginBottom: '0.75rem', color: 'var(--color-text-secondary)', textAlign: 'center' }}>
          Playing against {opponent.displayName}
        </div>
      )}
      {playMode === 'online' && multiplayer.error && (
        <div style={{ marginBottom: '0.75rem', color: '#fca5a5', textAlign: 'center' }}>
          {multiplayer.error}
        </div>
      )}
      <div className="ttt-board" role="grid" aria-label="Tic Tac Toe game board">
        {Array.from({ length: TicTacToeBoard.Size }, (_, r) =>
          Array.from({ length: TicTacToeBoard.Size }, (_, c) => {
            const val = boardToRender.get(r, c);
            const disabled = playMode === 'online'
              ? !multiplayer.match
                || multiplayer.match.status !== 'InProgress'
                || !isMyTurnOnline
                || val !== CellValue.None
                || multiplayer.isBusy
              : playMode === 'demo'
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


