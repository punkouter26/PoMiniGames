import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, CircleDot, Crosshair, Swords, Square, Baby, Car, Activity, Loader2, LogIn, UserRoundCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './SinglePlayerPage.css';

const SINGLE_PLAYER_GAMES = [
  {
    key: 'connectfive',
    to: '/connectfive',
    title: 'Connect Five',
    description: 'Drop pieces on a 9x9 board. Get 5 in a row to win.',
    ariaLabel: 'Play Connect Five single player',
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
    key: 'tictactoe',
    to: '/tictactoe',
    title: 'Tic Tac Toe',
    description: 'Classic game on a 6x6 board. Get 4 in a row to win.',
    ariaLabel: 'Play Tic Tac Toe single player',
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
    key: 'voxelshooter',
    to: '/voxelshooter',
    title: 'Voxel Shooter',
    description: 'Blast voxel enemies and survive the full round.',
    ariaLabel: 'Play Voxel Shooter single player',
    accent: '#00D9FF',
    accentGlow: 'rgba(0,217,255,0.28)',
    icon: <Crosshair size={44} color="#00D9FF" />,
  },
  {
    key: 'pofight',
    to: '/pofight',
    title: 'PoFight',
    description: 'Arcade fighter with PvCPU and CPU demo options.',
    ariaLabel: 'Play PoFight single player',
    accent: '#f97316',
    accentGlow: 'rgba(249,115,22,0.28)',
    icon: <Swords size={44} color="#f97316" />,
  },
  {
    key: 'podropsquare',
    to: '/podropsquare',
    title: 'PoDropSquare',
    description: 'Stack falling blocks and clear lines to score.',
    ariaLabel: 'Play PoDropSquare single player',
    accent: '#a78bfa',
    accentGlow: 'rgba(167,139,250,0.28)',
    icon: <Square size={44} color="#a78bfa" />,
  },
  {
    key: 'pobabytouch',
    to: '/pobabytouch',
    title: 'PoBabyTouch',
    description: 'Tap matching shapes before they disappear.',
    ariaLabel: 'Play PoBabyTouch single player',
    accent: '#ec4899',
    accentGlow: 'rgba(236,72,153,0.28)',
    icon: <Baby size={44} color="#ec4899" />,
  },
  {
    key: 'poraceragdoll',
    to: '/poraceragdoll',
    title: 'PoRaceRagdoll',
    description: 'Bet on ragdoll racers and watch the chaos unfold.',
    ariaLabel: 'Play PoRaceRagdoll single player',
    accent: '#22c55e',
    accentGlow: 'rgba(34,197,94,0.28)',
    icon: <Car size={44} color="#22c55e" />,
  },
  {
    key: 'posnakegame',
    to: '/posnakegame',
    title: 'PoSnakeGame',
    description: 'Battle royale snake — outlast all opponents.',
    ariaLabel: 'Play PoSnakeGame single player',
    accent: '#4ade80',
    accentGlow: 'rgba(74,222,128,0.28)',
    icon: <Activity size={44} color="#4ade80" />,
  },
] as const;

export default function SinglePlayerPage() {
  const navigate = useNavigate();
  const { config, isAuthenticated, isConfigured, isLoading, signIn } = useAuth();

  const signInLabel = config?.microsoftEnabled ? 'Sign in with Microsoft' : 'Sign in';
  const signInDescription = config?.microsoftEnabled
    ? 'Sign in with your Microsoft account to choose and play a single-player game.'
    : 'Sign in to choose and play a single-player game.';

  if (!isConfigured && !isLoading) {
    return (
      <div className="sp-page">
        <div className="sp-card sp-card--centered">
          <UserRoundCheck size={40} className="sp-icon" />
          <h1 className="sp-title">Single Player</h1>
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
          <UserRoundCheck size={40} className="sp-icon" />
          <h1 className="sp-title">Single Player</h1>
          <p className="sp-subtitle">{signInDescription}</p>
          <div className="sp-auth-banner-actions">
            <button className="sp-btn-primary" onClick={() => void signIn()}>
              <LogIn size={16} /> {signInLabel}
            </button>
            <button className="sp-btn-secondary" onClick={() => navigate('/')}>
              <ArrowLeft size={16} /> Home
            </button>
          </div>
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
          <h1 className="sp-title">Pick a Single-Player Game</h1>
        </div>

        <p className="sp-subtitle">Choose any game below and jump in.</p>

        <div className="sp-game-grid">
          {SINGLE_PLAYER_GAMES.map((game) => (
            <Link
              key={game.key}
              to={game.to}
              className="sp-game-card"
              aria-label={game.ariaLabel}
              style={{ '--accent': game.accent, '--accent-glow': game.accentGlow } as React.CSSProperties}
            >
              <div className="sp-game-icon">{game.icon}</div>
              <h2>{game.title}</h2>
              <p>{game.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
