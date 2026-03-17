import { Circle, CircleDot, RotateCcw, Users } from 'lucide-react';
import { Difficulty, GameResult, Piece } from '../shared/types';
import { GamePageShell } from '../shared/GamePageShell';
import { ConnectFiveBoard } from './ConnectFiveBoard';
import { useConnectFiveGame } from './useConnectFiveGame';
import './ConnectFivePage.css';

export default function ConnectFivePage() {
  const {
    board, boardToRender, difficulty, setDifficulty, gameResult, isAiTurn,
    hoveredCol, setHoveredCol, playMode, setPlayMode, resetGame, handleDrop,
    isWinCell, opponent, isMyTurnOnline, status, statItems, multiplayer,
    isAuthenticated, isConfigured, signIn, playerName,
  } = useConnectFiveGame();

  return (
    <GamePageShell
      title={<><CircleDot size={14} color="#f44336" /> Connect Five</>}
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
      {/* Column drop buttons */}
      <div className="cf-drop-row">
        {Array.from({ length: ConnectFiveBoard.Cols }, (_, c) => (
          <button
            key={c}
            className={`cf-drop-btn ${hoveredCol === c && gameResult === GameResult.InProgress && !isAiTurn ? 'active-column' : ''}`}
            disabled={playMode === 'online'
              ? !multiplayer.match
                || multiplayer.match.status !== 'InProgress'
                || !isMyTurnOnline
                || boardToRender.getTargetRow(c) < 0
                || multiplayer.isBusy
              : playMode === 'demo'
                ? true
                : gameResult !== GameResult.InProgress || isAiTurn || board.getTargetRow(c) < 0}
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
      <div className="cf-board" role="grid" aria-label="Connect Five game board">
        {Array.from({ length: ConnectFiveBoard.Rows }, (_, r) =>
          Array.from({ length: ConnectFiveBoard.Cols }, (_, c) => {
            const piece = boardToRender.get(r, c);
            const cls = [
              'cf-cell',
              piece === Piece.Red ? 'red' : piece === Piece.Yellow ? 'yellow' : '',
              isWinCell(r, c) ? 'win-cell' : '',
              playMode === 'online'
                ? multiplayer.match?.status !== 'InProgress' ? 'disabled' : ''
                : gameResult !== GameResult.InProgress ? 'disabled' : '',
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


