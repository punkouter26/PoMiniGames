import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Activity, Globe } from 'lucide-react';
import { GameCardGrid, type GameCardItem } from './GameCardGrid';
import './SinglePlayerPage.css';

const ONLINE_MULTI_GAMES: GameCardItem[] = [
  {
    key: 'porunner-multi',
    to: '/porunner?mode=multi',
    title: 'PoRunner',
    description: 'Type T-Y-G-H to sprint past opponents! Race to the finish online against real players.',
    ariaLabel: 'Play PoRunner online multiplayer',
    accent: '#fcd34d',
    accentGlow: 'rgba(252,211,77,0.28)',
    modes: ['Multi'],
    icon: <Activity size={44} color="#fcd34d" />,
  },
] as const;

export default function OnlineMultiplayerPage() {
  const navigate = useNavigate();

  return (
    <div className="sp-page">
      <div className="sp-card">
        <div className="sp-header">
          <button className="sp-back" onClick={() => navigate('/')}>
            <ArrowLeft size={16} /> Home
          </button>
          <h1 className="sp-title">
            <Globe size={22} style={{ verticalAlign: 'middle', marginRight: '0.4rem' }} />
            Online Multiplayer
          </h1>
        </div>
        <p className="sp-subtitle">Connect online and compete against real players in real time.</p>
        <GameCardGrid games={ONLINE_MULTI_GAMES} />
      </div>
    </div>
  );
}