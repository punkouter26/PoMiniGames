import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Crown, Loader2, LogIn, Users, Gamepad2, ArrowLeft } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLobby } from '../games/shared/useLobby';
import './LobbyPage.css';

const GAME_OPTIONS = [
  { key: 'tictactoe', label: 'Tic Tac Toe — 6×6, get 4 in a row' },
  { key: 'connectfive', label: 'Connect Five — 9×9, get 5 in a row' },
] as const;

export default function LobbyPage() {
  const navigate = useNavigate();
  const { config, isAuthenticated, isConfigured, isLoading: authLoading, signIn, user } = useAuth();
  const { players, hostUserId, isConnected, isBusy, error, startGame } = useLobby();
  const [selectedGame, setSelectedGame] = useState<string>(GAME_OPTIONS[0].key);

  const isHost = user?.userId === hostUserId;
  const canStart = isHost && players.length >= 2 && isConnected && !isBusy;
  const signInLabel = config?.microsoftEnabled ? 'Sign in with Microsoft' : 'Sign in';
  const signInDescription = config?.microsoftEnabled
    ? 'Sign in with your Microsoft account to join the lobby and play against others.'
    : 'Sign in to join the lobby and play against others.';

  // ── Not configured ──────────────────────────────────────────────────────────
  if (!isConfigured && !authLoading) {
    return (
      <div className="lobby-page">
        <div className="lobby-card">
          <Gamepad2 size={40} className="lobby-icon" />
          <h1 className="lobby-title">Play Online</h1>
          <p className="lobby-subtitle">
            Online sign-in is not available right now.
          </p>
          <button className="lobby-btn-secondary" onClick={() => navigate('/')}>
            <ArrowLeft size={16} /> Back to Home
          </button>
        </div>
      </div>
    );
  }

  // ── Loading auth ────────────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="lobby-page">
        <div className="lobby-card">
          <Loader2 size={32} className="lobby-spin" />
          <p className="lobby-subtitle">Loading...</p>
        </div>
      </div>
    );
  }

  // ── Not signed in ───────────────────────────────────────────────────────────
  if (!isAuthenticated) {
    return (
      <div className="lobby-page">
        <div className="lobby-card">
          <Gamepad2 size={40} className="lobby-icon" />
          <h1 className="lobby-title">Play Online</h1>
          <p className="lobby-subtitle">{signInDescription}</p>
          <button className="lobby-btn-primary" onClick={() => void signIn()}>
            <LogIn size={16} /> {signInLabel}
          </button>
          <button className="lobby-btn-secondary" onClick={() => navigate('/')}>
            <ArrowLeft size={16} /> Back to Home
          </button>
        </div>
      </div>
    );
  }

  // ── Signed in — show lobby ──────────────────────────────────────────────────
  return (
    <div className="lobby-page">
      <div className="lobby-card">
        <div className="lobby-header">
          <button className="lobby-back" onClick={() => navigate('/')}>
            <ArrowLeft size={16} /> Home
          </button>
          <h1 className="lobby-title">
            <Users size={24} /> Online Lobby
          </h1>
        </div>

        {/* Connection status */}
        {!isConnected && (
          <div className="lobby-connecting">
            <Loader2 size={16} className="lobby-spin" /> Connecting to lobby...
          </div>
        )}

        {/* Player list */}
        <div className="lobby-players-section">
          <h2 className="lobby-section-title">
            Players ({players.length})
          </h2>
          {players.length === 0 ? (
            <p className="lobby-waiting">Waiting for players to join...</p>
          ) : (
            <ul className="lobby-player-list">
              {players.map((p) => (
                <li key={p.userId} className={`lobby-player${p.userId === hostUserId ? ' lobby-player--host' : ''}`}>
                  {p.userId === hostUserId && (
                    <Crown size={14} className="lobby-crown" aria-label="Host" />
                  )}
                  <span className="lobby-player-name">{p.displayName}</span>
                  {p.userId === user?.userId && (
                    <span className="lobby-player-you">(you)</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {isConnected && players.length < 2 && (
            <p className="lobby-waiting-hint">
              Waiting for at least 1 more player...
            </p>
          )}
        </div>

        {/* Game picker — host only, 2+ players */}
        {isHost && players.length >= 2 && (
          <div className="lobby-start-section">
            <h2 className="lobby-section-title">Choose a Game</h2>
            <div className="lobby-game-options">
              {GAME_OPTIONS.map((g) => (
                <label
                  key={g.key}
                  className={`lobby-game-option${selectedGame === g.key ? ' lobby-game-option--selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="game"
                    value={g.key}
                    checked={selectedGame === g.key}
                    onChange={() => setSelectedGame(g.key)}
                  />
                  <span>{g.label}</span>
                </label>
              ))}
            </div>
            <button
              className="lobby-btn-primary lobby-btn-start"
              disabled={!canStart}
              onClick={() => void startGame(selectedGame)}
            >
              {isBusy ? <Loader2 size={16} className="lobby-spin" /> : <Gamepad2 size={16} />}
              Start Game →
            </button>
          </div>
        )}

        {/* Waiting for host — non-host, 2+ players */}
        {!isHost && players.length >= 2 && (
          <div className="lobby-waiting-start">
            <Loader2 size={16} className="lobby-spin" />
            <span>Waiting for the host to start the game...</span>
          </div>
        )}

        {error && <p className="lobby-error">{error}</p>}
      </div>
    </div>
  );
}
