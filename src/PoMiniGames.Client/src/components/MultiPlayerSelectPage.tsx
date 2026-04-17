import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CircleDot, Crosshair, Swords, Activity, Users } from 'lucide-react';
import { apiService } from '../games/shared/apiService';
import { GameCardGrid, type GameCardItem } from './GameCardGrid';
import './SinglePlayerPage.css';

type GameOption = { key: string; label: string };

const FALLBACK_GAME_OPTIONS: GameOption[] = [
  { key: 'tictactoe', label: 'Tic Tac Toe' },
  { key: 'connectfive', label: 'Connect Five' },
  { key: 'posnakegame', label: 'PoSnakeGame' },
  { key: 'pofight', label: 'PoFight' },
  { key: 'voxelshooter', label: 'Voxel Shooter' },
];

const GAME_VISUALS: Record<string, Pick<GameCardItem, 'accent' | 'accentGlow' | 'icon' | 'description'>> = {
  tictactoe: {
    accent: '#ef4444',
    accentGlow: 'rgba(239,68,68,0.28)',
    icon: (
      <>
        <CircleDot size={40} stroke="none" fill="#ef4444" />
        <CircleDot size={40} stroke="none" fill="#f59e0b" />
      </>
    ),
    description: 'Classic game on a 6x6 board. Get 4 in a row to win.',
  },
  connectfive: {
    accent: '#f44336',
    accentGlow: 'rgba(244,67,54,0.28)',
    icon: (
      <>
        <CircleDot size={44} color="#f44336" />
        <CircleDot size={44} color="#facc15" />
      </>
    ),
    description: 'Drop pieces on a 9x9 board. Get 5 in a row to win.',
  },
  posnakegame: {
    accent: '#4ade80',
    accentGlow: 'rgba(74,222,128,0.28)',
    icon: <Activity size={44} color="#4ade80" />,
    description: 'Battle royale snake — outlast all opponents.',
  },
  pofight: {
    accent: '#f97316',
    accentGlow: 'rgba(249,115,22,0.28)',
    icon: <Swords size={44} color="#f97316" />,
    description: 'Arcade fighter — go head-to-head with another player.',
  },
  voxelshooter: {
    accent: '#00D9FF',
    accentGlow: 'rgba(0,217,255,0.28)',
    icon: <Crosshair size={44} color="#00D9FF" />,
    description: 'Blast enemies in a real-time voxel arena.',
  },
};

function buildCards(games: GameOption[], _navigate: ReturnType<typeof useNavigate>): GameCardItem[] {
  return games.map((g) => {
    const visuals = GAME_VISUALS[g.key] ?? {
      accent: '#a78bfa',
      accentGlow: 'rgba(167,139,250,0.28)',
      icon: <Users size={44} color="#a78bfa" />,
      description: 'Multiplayer game.',
    };
    return {
      key: g.key,
      to: `/lobby?game=${g.key}`,
      title: g.label,
      description: visuals.description,
      ariaLabel: `Play ${g.label} multiplayer`,
      accent: visuals.accent,
      accentGlow: visuals.accentGlow,
      icon: visuals.icon,
      modes: ['2P'] as Array<'1P' | '2P' | 'Demo'>,
    };
  });
}

export default function MultiPlayerSelectPage() {
  const navigate = useNavigate();
  const [games, setGames] = useState<GameOption[]>(FALLBACK_GAME_OPTIONS);

  useEffect(() => {
    apiService.getSupportedMultiplayerGames().then(result => {
      if (!result || result.length === 0) return;
      const opts = result
        .filter(g => g.enabledForQueue)
        .map(g => ({ key: g.gameKey, label: g.displayName }));
      if (opts.length > 0) setGames(opts);
    }).catch(() => { /* keep fallback */ });
  }, []);

  const cards = buildCards(games, navigate);

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
        </div>
        <p className="sp-subtitle">Select a game to enter the online lobby with another player.</p>
        <GameCardGrid games={cards} />
      </div>
    </div>
  );
}
