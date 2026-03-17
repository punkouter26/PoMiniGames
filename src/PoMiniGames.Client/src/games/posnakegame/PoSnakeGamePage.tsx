import { useState, useCallback, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Loader2, Wifi, WifiOff } from 'lucide-react';
import { GameCanvas } from './GameCanvas';
import { MultiplayerSnakeCanvas } from './MultiplayerSnakeCanvas';
import { HighScoreModal } from './HighScoreModal';
import { HighScoreTable } from './HighScoreTable';
import { getHighScores, type SnakeHighScore } from './snakeService';
import { useSnakeMultiplayer } from './useSnakeMultiplayer';
import './posnakegame.css';

type GameMode = 'solo' | 'online';

// ── Online multiplayer panel ──────────────────────────────────────────────────
function OnlinePanel() {
  const {
    match, isHost, gameState, myPlayerId, opponentName, winner,
    isConnected, isBusy, error,
    joinQueue, leaveMatch, sendDirection,
  } = useSnakeMultiplayer();

  const [roundKey, setRoundKey] = useState(0);

  const handlePlayAgain = async () => {
    await leaveMatch();
    setRoundKey(k => k + 1);
    await joinQueue();
  };

  const handleLeave = async () => {
    await leaveMatch();
  };

  const isWaiting  = match?.status === 'WaitingForOpponent';
  const isPlaying  = match?.status === 'InProgress';
  const isFinished = match?.status === 'Completed' || match?.status === 'Abandoned';

  if (!match) {
    return (
      <div className="psg-online-panel">
        <div className={`psg-connection-status ${isConnected ? 'psg-status-connected' : 'psg-status-disconnected'}`}>
          {isConnected ? <Wifi size={18} /> : <WifiOff size={18} />}
          <span>{isConnected ? 'Connected' : 'Connecting…'}</span>
        </div>
        {error && <p className="psg-error-msg">{error}</p>}
        <button
          className="psg-new-game-btn"
          disabled={isBusy || !isConnected}
          onClick={() => void joinQueue()}
        >
          {isBusy ? <Loader2 size={16} className="psg-spinner" style={{ display: 'inline' }} /> : '🔍 Find Opponent'}
        </button>
        <p className="psg-hint-text">
          You'll be matched with the first available player.
        </p>
      </div>
    );
  }

  if (isWaiting) {
    return (
      <div className="psg-online-panel">
        <Loader2 size={32} style={{ color: 'var(--psg-green)', animation: 'spin 1s linear infinite' }} />
        <p className="psg-waiting-msg">Waiting for opponent…</p>
        <button
          className="psg-new-game-btn"
          style={{ background: 'transparent', border: '1px solid #555', color: '#aaa' }}
          onClick={() => void leaveMatch()}
        >
          Cancel
        </button>
      </div>
    );
  }

  if (isFinished && !isPlaying) {
    return (
      <div className="psg-match-ended-panel">
        <p className="psg-match-ended-text">Match ended.</p>
        <button className="psg-new-game-btn" onClick={() => void handlePlayAgain()}>Play Again</button>
      </div>
    );
  }

  return (
    <MultiplayerSnakeCanvas
      key={roundKey}
      gameState={gameState}
      isHost={isHost}
      myPlayerId={myPlayerId}
      opponentName={opponentName}
      winner={winner}
      sendDirection={sendDirection}
      onPlayAgain={() => void handlePlayAgain()}
      onLeave={() => void handleLeave()}
    />
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function PoSnakeGamePage() {
  const [searchParams] = useSearchParams();
  const defaultMode: GameMode = searchParams.get('online') === '1' ? 'online' : 'solo';
  const [mode, setMode] = useState<GameMode>(defaultMode);

  const [gameKey, setGameKey] = useState(0);
  const [showModal, setShowModal] = useState(false);
  const [gameResult, setGameResult] = useState<{
    score: number;
    snakeLength: number;
    foodEaten: number;
    gameDuration: number;
  } | null>(null);
  const [scores, setScores] = useState<SnakeHighScore[]>([]);
  const [loadingScores, setLoadingScores] = useState(true);

  useEffect(() => {
    getHighScores().then(s => { setScores(s); setLoadingScores(false); });
  }, []);

  const refreshScores = useCallback(() => {
    getHighScores().then(setScores);
  }, []);

  const handleGameOver = useCallback((score: number, snakeLength: number, foodEaten: number, gameDuration: number) => {
    setGameResult({ score, snakeLength, foodEaten, gameDuration });
    setShowModal(true);
  }, []);

  const handlePlayAgain = useCallback(() => {
    setShowModal(false);
    setGameResult(null);
    setGameKey(k => k + 1);
  }, []);

  const handleScoreSubmitted = useCallback(() => {
    setShowModal(false);
    setGameResult(null);
    setGameKey(k => k + 1);
    refreshScores();
  }, [refreshScores]);

  return (
    <div className="psg-page">
      <div className="psg-page-header">
        <Link to="/" className="psg-home-btn" aria-label="Back to home">←</Link>
        <h1 className="psg-title">Battle Arena 🐍</h1>
        {mode === 'solo' && (
          <button className="psg-new-game-btn" onClick={handlePlayAgain}>New Game</button>
        )}
      </div>

      {/* Mode tabs */}
      <div className="psg-mode-tabs">
        <button
          className={`psg-mode-tab${mode === 'solo' ? ' psg-mode-tab--active' : ''}`}
          onClick={() => setMode('solo')}
        >
          🎮 Solo
        </button>
        <button
          className={`psg-mode-tab${mode === 'online' ? ' psg-mode-tab--active' : ''}`}
          onClick={() => setMode('online')}
        >
          🌐 2 Player Online
        </button>
      </div>

      {mode === 'solo' ? (
        <>
          <GameCanvas key={gameKey} onGameOver={handleGameOver} />

          <div className="psg-leaderboard">
            <h2 className="psg-leaderboard-title">🏆 Leaderboard</h2>
            {loadingScores ? (
              <div className="psg-loading">
                <span className="psg-spinner" />
                Loading scores…
              </div>
            ) : (
              <HighScoreTable scores={scores} />
            )}
          </div>

          {showModal && gameResult && (
            <HighScoreModal
              score={gameResult.score}
              snakeLength={gameResult.snakeLength}
              foodEaten={gameResult.foodEaten}
              gameDuration={gameResult.gameDuration}
              onClose={handlePlayAgain}
              onSubmitted={handleScoreSubmitted}
            />
          )}
        </>
      ) : (
        <OnlinePanel />
      )}
    </div>
  );
}
