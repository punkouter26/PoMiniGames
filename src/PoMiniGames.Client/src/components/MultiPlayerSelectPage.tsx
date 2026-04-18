import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CircleDot, Users, Gamepad2 } from 'lucide-react';
import { GameCardGrid, type GameCardItem } from './GameCardGrid';
import './SinglePlayerPage.css';

const LOCAL_TWO_PLAYER_GAMES: GameCardItem[] = [
  {
    key: 'tictactoe-local',
    to: '/tictactoe?local=1',
    title: 'Tic Tac Toe',
    description: 'Local pass-and-play on one device. Take turns as X and O.',
    ariaLabel: 'Play Tic Tac Toe local 2 player',
    accent: '#ef4444',
    accentGlow: 'rgba(239,68,68,0.28)',
    modes: ['2P'],
    icon: (
      <>
        <CircleDot size={40} stroke="none" fill="#ef4444" />
        <CircleDot size={40} stroke="none" fill="#f59e0b" />
      </>
    ),
  },
  {
    key: 'connectfive-local',
    to: '/connectfive?local=1',
    title: 'Connect Five',
    description: 'Local couch play on one device. Alternate drops to make 5 in a row.',
    ariaLabel: 'Play Connect Five local 2 player',
    accent: '#f44336',
    accentGlow: 'rgba(244,67,54,0.28)',
    modes: ['2P'],
    icon: (
      <>
        <CircleDot size={44} color="#f44336" />
        <CircleDot size={44} color="#facc15" />
      </>
    ),
  },
] as const;

export default function MultiPlayerSelectPage() {
  const navigate = useNavigate();

  return (
    <div className="sp-page">
      <div className="sp-card">
        <div className="sp-header">
          <button className="sp-back" onClick={() => navigate('/')}>
            <ArrowLeft size={16} /> Home
          </button>
          <h1 className="sp-title">
            <Users size={22} style={{ verticalAlign: 'middle', marginRight: '0.4rem' }} />
            Pick a 2-Player Game
          </h1>
          <button className="sp-btn-secondary" onClick={() => navigate('/single-player?mode=local-2p')}>
            <Gamepad2 size={14} /> All 2P games
          </button>
        </div>
        <p className="sp-subtitle">Choose a game for local 2-player couch play on this device.</p>
        <GameCardGrid games={LOCAL_TWO_PLAYER_GAMES} />
      </div>
    </div>
  );
}
