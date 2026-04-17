import { Gamepad2, MonitorPlay, Users, UserRoundCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import './Home.css';

const DEMO_START_URL = '/tictactoe?demo=1&demo_rotation=1&demo_idx=0';

export default function Home() {
  const navigate = useNavigate();

  return (
    <div className="home-container">
      {/* Floating parallax orbs — independent per-orb animation */}
      <span className="home-orb home-orb--1" aria-hidden="true" />
      <span className="home-orb home-orb--2" aria-hidden="true" />
      <span className="home-orb home-orb--3" aria-hidden="true" />
      <span className="home-orb home-orb--4" aria-hidden="true" />
      <span className="home-orb home-orb--5" aria-hidden="true" />

      <h1 className="home-title">
        <span className="home-title-icon">
          <Gamepad2 size={40} strokeWidth={1.5} />
        </span>
        PoMiniGames
      </h1>
      <p className="home-subtitle">Choose how you want to play</p>

      <div className="home-modes">
        <button type="button" className="home-mode-btn home-mode-btn--2p" aria-label="Play 2 players" autoFocus onClick={() => void navigate('/multi-player-select')}>
          <span className="home-mode-icon"><Users size={32} /></span>
          <span className="home-mode-label">2 Players</span>
          <span className="home-mode-desc">Online multiplayer</span>
        </button>

        <button type="button" className="home-mode-btn home-mode-btn--1p" aria-label="Play 1 player" onClick={() => void navigate('/single-player')}>
          <span className="home-mode-icon"><UserRoundCheck size={32} /></span>
          <span className="home-mode-label">1 Player</span>
          <span className="home-mode-desc">Solo &amp; leaderboards</span>
        </button>

        <button type="button" className="home-mode-btn home-mode-btn--demo" aria-label="Watch demo mode" onClick={() => void navigate(DEMO_START_URL)}>
          <span className="home-mode-icon"><MonitorPlay size={32} /></span>
          <span className="home-mode-label">Demo</span>
          <span className="home-mode-desc">Autoplay all games</span>
        </button>
      </div>
    </div>
  );
}

