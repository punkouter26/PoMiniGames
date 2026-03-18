import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CircleDot, Loader2, LogIn, Users, Zap } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { GameCardGrid, type GameCardItem } from './GameCardGrid';
import './SinglePlayerPage.css';

const MULTIPLAYER_GAMES: GameCardItem[] = [
  {
    key: 'tictactoe',
    to: '/tictactoe?online=1',
    title: 'Tic Tac Toe',
    description: 'Classic 6×6 board. Get 4 in a row to beat your opponent.',
    ariaLabel: 'Play Tic Tac Toe online multiplayer',
    accent: '#ef4444',
    accentGlow: 'rgba(239,68,68,0.28)',
    icon: (
      <>
        <CircleDot size={40} stroke="none" fill="#ef4444" />
        <CircleDot size={40} stroke="none" fill="#f59e0b" />
      </>
    ),
  },
  {
    key: 'connectfive',
    to: '/connectfive?online=1',
    title: 'Connect Five',
    description: 'Drop pieces on a 9×9 board. Get 5 in a row to win.',
    ariaLabel: 'Play Connect Five online multiplayer',
    accent: '#f44336',
    accentGlow: 'rgba(244,67,54,0.28)',
    icon: (
      <>
        <CircleDot size={44} color="#f44336" />
        <CircleDot size={44} color="#facc15" />
      </>
    ),
  },
  {
    key: 'posnakegame',
    to: '/posnakegame?online=1',
    title: 'PoSnakeGame',
    description: 'Battle Arena — survive longer than your opponent.',
    ariaLabel: 'Play PoSnakeGame online multiplayer',
    accent: '#00ff7f',
    accentGlow: 'rgba(0,255,127,0.28)',
    icon: (
      <>
        <CircleDot size={40} stroke="none" fill="#00ff7f" />
        <CircleDot size={40} stroke="none" fill="#00e5ff" />
      </>
    ),
  },
] as const;

export default function MultiplayerPage() {
  const navigate = useNavigate();
  const { config, isAuthenticated, isConfigured, isLoading, signIn, devBypass } = useAuth();
  const [devName, setDevName] = useState('');

  const signInLabel = config?.microsoftEnabled ? 'Sign in with Microsoft' : 'Sign in';
  const showDevPanel = window.location.hostname === 'localhost' || Boolean(config?.devLoginEnabled);
  const signInDescription = config?.microsoftEnabled
    ? 'Sign in with your Microsoft account to play online multiplayer.'
    : 'Sign in to play online multiplayer.';

  if (!isConfigured && !isLoading) {
    return (
      <div className="sp-page">
        <div className="sp-card sp-card--centered">
          <Users size={40} className="sp-icon" />
          <h1 className="sp-title">Multiplayer</h1>
          <p className="sp-subtitle">Online sign-in is not available right now.</p>
          <button className="sp-btn-secondary" onClick={() => navigate('/')}>
            <ArrowLeft size={16} /> Back to Home
          </button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="sp-page">
        <div className="sp-card sp-card--centered">
          <Loader2 size={32} className="sp-spin" />
          <p className="sp-subtitle">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="sp-page">
        <div className="sp-card sp-card--centered">
          <Users size={40} className="sp-icon" />
          <h1 className="sp-title">Multiplayer</h1>
          <p className="sp-subtitle">{signInDescription}</p>
          <div className="sp-auth-banner-actions">
            {config?.microsoftEnabled && (
              <button className="sp-btn-primary" onClick={() => void signIn()}>
                <LogIn size={16} /> {signInLabel}
              </button>
            )}
            <button className="sp-btn-secondary" onClick={() => navigate('/')}>
              <ArrowLeft size={16} /> Home
            </button>
          </div>
          {showDevPanel && (
            <div className="lobby-dev-panel">
              <p className="lobby-dev-panel__label"><Zap size={13} /> Dev Login — no OAuth needed</p>
              <div className="lobby-dev-panel__row">
                <input
                  className="lobby-dev-panel__input"
                  type="text"
                  placeholder="Your name (e.g. Player1)"
                  value={devName}
                  onChange={e => setDevName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && devName.trim()) void devBypass(devName.trim()); }}
                />
                <button
                  className="sp-btn-primary"
                  disabled={!devName.trim()}
                  onClick={() => void devBypass(devName.trim())}
                >
                  <Zap size={14} /> Login
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="sp-page">
      <div className="sp-card">
        <div className="sp-header">
          <button className="sp-back" onClick={() => navigate('/')}>
            <ArrowLeft size={16} /> Home
          </button>
          <h1 className="sp-title">Pick a Multiplayer Game</h1>
        </div>

        <p className="sp-subtitle">Choose a game and find an opponent online.</p>

        <div className="sp-game-grid">
          <GameCardGrid games={MULTIPLAYER_GAMES} />
        </div>
      </div>
    </div>
  );
}
