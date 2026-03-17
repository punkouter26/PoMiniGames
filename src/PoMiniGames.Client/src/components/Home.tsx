import { Link } from 'react-router-dom';
import { Bot, Gamepad2, Users, UserRoundCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import HomeHighScores from './HomeHighScores';
import './Home.css';

export default function Home() {
  const navigate = useNavigate();
  const { config, devLogin, isLoading } = useAuth();

  const canUseDevLogin = Boolean(config?.devLoginEnabled && !isLoading);

  const handleDevLogin = async (targetPath: '/lobby' | '/single-player') => {
    const profile = await devLogin({
      displayName: `E2E-${targetPath === '/lobby' ? '2P' : '1P'}-${Date.now()}`,
    });

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
        <Link to="/lobby" className="home-mode-btn home-mode-btn--2p" aria-label="Play 2 players" autoFocus>
          <span className="home-mode-icon"><Users size={36} /></span>
          <span className="home-mode-label">2 Players</span>
          <span className="home-mode-desc">Online multiplayer</span>
        </Link>

        <Link to="/single-player" className="home-mode-btn home-mode-btn--1p" aria-label="Play 1 player">
          <span className="home-mode-icon"><UserRoundCheck size={36} /></span>
          <span className="home-mode-label">1 Player</span>
          <span className="home-mode-desc">Solo game</span>
        </Link>

        <Link to="/demo" className="home-mode-btn home-mode-btn--demo" aria-label="Play demo mode">
          <span className="home-mode-icon"><Bot size={36} /></span>
          <span className="home-mode-label">Demo Mode</span>
          <span className="home-mode-desc">CPU vs CPU kiosk</span>
        </Link>
      </div>

      {canUseDevLogin && (
        <div className="home-dev-logins">
          <button
            type="button"
            className="home-dev-login-btn"
            onClick={() => void handleDevLogin('/lobby')}
            aria-label="Dev login for 2 player"
          >
            Dev Login → 2P
          </button>
          <button
            type="button"
            className="home-dev-login-btn"
            onClick={() => void handleDevLogin('/single-player')}
            aria-label="Dev login for 1 player"
          >
            Dev Login → 1P
          </button>
        </div>
      )}

      <HomeHighScores />
    </div>
  );
}

