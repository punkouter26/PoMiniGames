import { Link } from 'react-router-dom';
import { Bot, Gamepad2, Users, UserRoundCheck, Zap } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getDevUserFromUrl } from '../games/shared/apiService';
import { useNavigate } from 'react-router-dom';
import { useCallback } from 'react';
import HomeHighScores from './HomeHighScores';
import './Home.css';

export default function Home() {
  const navigate = useNavigate();
  const { config, devBypass, isLoading, signIn, isAuthenticated } = useAuth();

  const canUseDevLogin = Boolean(config?.devLoginEnabled && !isLoading);
  // ?user=Alice in the URL → auto-authenticated on load; show identity in the panel
  const urlUser = getDevUserFromUrl();

  const handleModeClick = useCallback(async (targetPath: '/multiplayer' | '/single-player') => {
    if (config?.microsoftEnabled && !isAuthenticated) {
      const profile = await signIn();
      if (profile) void navigate(targetPath);
    } else {
      void navigate(targetPath);
    }
  }, [config, isAuthenticated, signIn, navigate]);

  const handleDevBypass = async (targetPath: '/lobby' | '/single-player') => {
    const profile = await devBypass();
    if (profile) {
      void navigate(targetPath);
    }
  };

  return (
    <div className="home-container">
      <h1 className="home-title">
        <span className="home-title-icon">
          <Gamepad2 size={48} strokeWidth={1.5} />
        </span>
        PoMiniGames
      </h1>
      <p className="home-subtitle">Choose how you want to play</p>

      <div className="home-modes">
        <button type="button" className="home-mode-btn home-mode-btn--2p" aria-label="Play 2 players" autoFocus onClick={() => void handleModeClick('/multiplayer')}>
          <span className="home-mode-icon"><Users size={36} /></span>
          <span className="home-mode-label">2 Players</span>
          <span className="home-mode-desc">Online multiplayer</span>
        </button>

        <button type="button" className="home-mode-btn home-mode-btn--1p" aria-label="Play 1 player" onClick={() => void handleModeClick('/single-player')}>
          <span className="home-mode-icon"><UserRoundCheck size={36} /></span>
          <span className="home-mode-label">1 Player</span>
          <span className="home-mode-desc">Solo game</span>
        </button>

        <Link to="/demo" className="home-mode-btn home-mode-btn--demo" aria-label="Play demo mode">
          <span className="home-mode-icon"><Bot size={36} /></span>
          <span className="home-mode-label">Demo Mode</span>
          <span className="home-mode-desc">CPU vs CPU kiosk</span>
        </Link>
      </div>

      {canUseDevLogin && (
        <div className="home-dev-bypass-section">
          <div className="home-dev-bypass-header">
            <Zap size={13} />
            <span>Developer Bypass</span>
            {urlUser && (
              <span className="home-dev-bypass-identity" title="Identity from ?user= URL param">
                {urlUser}
              </span>
            )}
          </div>

          {urlUser ? (
            <p className="home-dev-bypass-desc">
              Auto-authenticated as <strong>{urlUser}</strong> via URL param.
              Open a new incognito tab with <code>?user=Player2</code> for a second player.
            </p>
          ) : (
            <p className="home-dev-bypass-desc">
              Add <code>?user=Name</code> to the URL for identity-per-tab multiplayer testing.
              <br />
              <span className="home-dev-bypass-url-example">
                Tab 1: <code>localhost:5173/?user=Player1</code> &nbsp;·&nbsp;
                Tab 2 (incognito): <code>?user=Player2</code>
              </span>
            </p>
          )}

          <div className="home-dev-bypass-actions">
            <button
              type="button"
              className="home-dev-bypass-btn"
              onClick={() => void handleDevBypass('/lobby')}
              aria-label="Developer bypass for 2 player"
            >
              <Zap size={13} />
              {urlUser ? `${urlUser} → 2P` : 'Bypass → 2P'}
            </button>
            <button
              type="button"
              className="home-dev-bypass-btn"
              onClick={() => void handleDevBypass('/single-player')}
              aria-label="Developer bypass for 1 player"
            >
              <Zap size={13} />
              {urlUser ? `${urlUser} → 1P` : 'Bypass → 1P'}
            </button>
          </div>
        </div>
      )}

      <HomeHighScores />
    </div>
  );
}

