import { Gamepad2, Globe, MonitorPlay, Users, UserRoundCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import './Home.css';

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
        <button type="button" className="home-mode-btn home-mode-btn--1p" aria-label="Play 1 player" autoFocus onClick={() => void navigate('/single-player')}>
          <span className="home-mode-icon"><UserRoundCheck size={32} /></span>
          <span className="home-mode-label">1 Player</span>
        </button>

        <button type="button" className="home-mode-btn home-mode-btn--2p" aria-label="Play 2 players locally" onClick={() => void navigate('/multi-player-select')}>
          <span className="home-mode-icon"><Users size={32} /></span>
          <span className="home-mode-label">2 Player (local)</span>
        </button>

        <button type="button" className="home-mode-btn home-mode-btn--multi" aria-label="Play online multiplayer" onClick={() => void navigate('/online-multiplayer')}>
          <span className="home-mode-icon"><Globe size={32} /></span>
          <span className="home-mode-label">Multi player (online)</span>
        </button>

        <button type="button" className="home-mode-btn home-mode-btn--demo" aria-label="Watch demo mode" onClick={() => void navigate('/single-player?mode=demo')}>
          <span className="home-mode-icon"><MonitorPlay size={32} /></span>
          <span className="home-mode-label">Demo</span>
        </button>
      </div>
    </div>
  );
}

