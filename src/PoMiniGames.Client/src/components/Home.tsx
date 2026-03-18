import { Bot, Gamepad2, Users, UserRoundCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import HomeHighScores from './HomeHighScores';
import { pickRandomDemoRoute } from '../constants/demoRoutes';
import './Home.css';

export default function Home() {
  const navigate = useNavigate();

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
        <button type="button" className="home-mode-btn home-mode-btn--2p" aria-label="Play 2 players" autoFocus onClick={() => void navigate('/lobby')}>
          <span className="home-mode-icon"><Users size={36} /></span>
          <span className="home-mode-label">2 Players</span>
          <span className="home-mode-desc">Online multiplayer</span>
        </button>

        <button type="button" className="home-mode-btn home-mode-btn--1p" aria-label="Play 1 player" onClick={() => void navigate('/single-player')}>
          <span className="home-mode-icon"><UserRoundCheck size={36} /></span>
          <span className="home-mode-label">1 Player</span>
          <span className="home-mode-desc">Solo game</span>
        </button>

        <button type="button" className="home-mode-btn home-mode-btn--demo" aria-label="Play demo mode" onClick={() => void navigate(pickRandomDemoRoute())}>
          <span className="home-mode-icon"><Bot size={36} /></span>
          <span className="home-mode-label">Demo Mode</span>
          <span className="home-mode-desc">CPU vs CPU kiosk</span>
        </button>
      </div>

      <HomeHighScores />
    </div>
  );
}

