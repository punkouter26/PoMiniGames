import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Crown, Loader2, LogIn, Users, Gamepad2, ArrowLeft } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePlayerName } from '../context/PlayerNameContext';
import { useLobby } from '../games/shared/useLobby';
import { apiService } from '../games/shared/apiService';
import './LobbyPage.css';

type GameOption = { key: string; label: string };

// Fallback list shown while the API loads or if offline.
const FALLBACK_GAME_OPTIONS: GameOption[] = [
  { key: 'tictactoe', label: 'Tic Tac Toe' },
  { key: 'connectfive', label: 'Connect Five' },
  { key: 'posnakegame', label: 'PoSnakeGame' },
];

export default function LobbyPage() {
  const navigate = useNavigate();
  const { config, isAuthenticated, isLoading: authLoading, signIn, devBypass, user } = useAuth();
  const { playerName, setPlayerName } = usePlayerName();
  const { players, hostUserId, isConnected, isBusy, error, startGame } = useLobby();
  const [gameOptions, setGameOptions] = useState<GameOption[]>(FALLBACK_GAME_OPTIONS);
  const [selectedGame, setSelectedGame] = useState<string>('tictactoe');
  const [joiningName, setJoiningName] = useState(playerName);
  const [isJoining, setIsJoining] = useState(false);

  const canUseAnon = window.location.hostname === 'localhost' || Boolean(config?.devLoginEnabled);
  const canUseMicrosoft = Boolean(config?.microsoftEnabled);

  useEffect(() => {
    apiService.getSupportedMultiplayerGames().then(games => {
      if (!games || games.length === 0) return;
      const opts = games
        .filter(g => g.enabledForQueue)
        .map(g => ({ key: g.gameKey, label: g.displayName }));
      if (opts.length > 0) {
        setGameOptions(opts);
        setSelectedGame(prev =>
          opts.some(o => o.key === prev) ? prev : opts[0]!.key,
        );
      }
    }).catch(() => { /* keep fallback list on error */ });
  }, []);

  const isHost = user?.userId === hostUserId;
  const canStart = isHost && players.length >= 2 && isConnected && !isBusy;

  const handleAnonJoin = async () => {
    const name = joiningName.trim() || playerName;
    setIsJoining(true);
    setPlayerName(name);
    await devBypass(name);
    setIsJoining(false);
  };

  // ── Pre-auth gate ────────────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="lobby-page">
        <div className="lobby-card lobby-card--centered">
          <Loader2 size={32} className="lobby-spin" />
          <p className="lobby-subtitle">Connecting...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="lobby-page">
        <div className="lobby-card lobby-card--centered">
          <Gamepad2 size={40} className="lobby-icon" />
          <h1 className="lobby-title">2 Player Lobby</h1>
          <p className="lobby-subtitle">Pick a name and jump in — no account needed.</p>

          {canUseAnon && (
            <div className="lobby-anon-join">
              <input
                className="lobby-anon-input"
                type="text"
                placeholder="Your name"
                value={joiningName}
                maxLength={20}
                onChange={e => setJoiningName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void handleAnonJoin(); }}
                autoFocus
              />
              <button
                className="lobby-btn-primary lobby-btn-join"
                disabled={isJoining}
                onClick={() => void handleAnonJoin()}
              >
                {isJoining ? <Loader2 size={16} className="lobby-spin" /> : <Users size={16} />}
                Join Lobby
              </button>
            </div>
          )}

          {canUseMicrosoft && (
            <button className="lobby-btn-microsoft" onClick={() => void signIn()}>
              <LogIn size={16} /> Sign in with Microsoft
            </button>
          )}

          {!canUseAnon && !canUseMicrosoft && (
            <p className="lobby-subtitle">Online play is not available right now.</p>
          )}

          <button className="lobby-btn-secondary" onClick={() => navigate('/')}>
            <ArrowLeft size={16} /> Back
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
              {gameOptions.map((g) => (
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
