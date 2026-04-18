import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CircleDot, Crosshair, Swords, Square, Baby, Car, Activity, Search, WifiOff, PersonStanding, Users } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { GameCardGrid, type GameCardItem } from './GameCardGrid';
import HomeHighScores from './HomeHighScores';
import './SinglePlayerPage.css';

type PageMode = 'play' | 'local-2p' | 'demo';

const SINGLE_PLAYER_GAMES: GameCardItem[] = [
  {
    key: 'connectfive',
    to: '/connectfive',
    title: 'Connect Five',
    description: 'Drop pieces on a 9x9 board. Get 5 in a row to win.',
    ariaLabel: 'Play Connect Five single player',
    accent: '#f44336',
    accentGlow: 'rgba(244,67,54,0.28)',
    modes: ['1P', '2P', 'Demo'],
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
    modes: ['1P', '2P', 'Demo'],
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
    modes: ['1P'],
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
    modes: ['1P', 'Demo'],
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
    modes: ['1P'],
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
    modes: ['1P'],
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
    modes: ['1P', 'Demo'],
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
    modes: ['1P'],
    icon: <Activity size={44} color="#4ade80" />,
  },
  {
    key: 'pohorserace',
    to: '/pohorserace',
    title: 'PoHorseRace',
    description: 'Carnival arcade horse race — swipe to roll, score to win!',
    ariaLabel: 'Play PoHorseRace single player',
    accent: '#f59e0b',
    accentGlow: 'rgba(245,158,11,0.28)',
    modes: ['1P', 'Demo'],
    icon: <PersonStanding size={44} color="#f59e0b" />,
  },
] as const;

const DEMO_GAMES: GameCardItem[] = [
  {
    key: 'tictactoe-demo',
    to: '/tictactoe?demo=1&demo_return=1',
    title: 'Tic Tac Toe Demo',
    description: 'Watch CPU vs CPU battle it out.',
    ariaLabel: 'Watch Tic Tac Toe demo',
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
    key: 'connectfive-demo',
    to: '/connectfive?demo=1&demo_return=1',
    title: 'Connect Five Demo',
    description: 'Watch the CPU auto-play on a 9x9 board.',
    ariaLabel: 'Watch Connect Five demo',
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
    key: 'pofight-demo',
    to: '/pofight?demo=1&demo_return=1',
    title: 'PoFight Demo',
    description: 'Arcade fighter in CPU vs CPU kiosk mode.',
    ariaLabel: 'Watch PoFight demo',
    accent: '#f97316',
    accentGlow: 'rgba(249,115,22,0.28)',
    icon: <Swords size={44} color="#f97316" />,
  },
  {
    key: 'poraceragdoll-demo',
    to: '/poraceragdoll',
    title: 'PoRaceRagdoll',
    description: 'Enjoy the chaos and place a bet on the racers.',
    ariaLabel: 'Watch PoRaceRagdoll demo',
    accent: '#22c55e',
    accentGlow: 'rgba(34,197,94,0.28)',
    icon: <Car size={44} color="#22c55e" />,
  },
  {
    key: 'pohorserace-demo',
    to: '/pohorserace',
    title: 'PoHorseRace Demo',
    description: 'Watch all 8 lanes auto-race in arcade demo mode.',
    ariaLabel: 'Watch PoHorseRace demo',
    accent: '#f59e0b',
    accentGlow: 'rgba(245,158,11,0.28)',
    icon: <PersonStanding size={44} color="#f59e0b" />,
  },
] as const;

export default function SinglePlayerPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isLoading } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);

  // Detect whether the API is reachable (fire-and-forget, no blocking)
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        await fetch('/api/health/ping', { signal: ctrl.signal });
        setApiOnline(true);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setApiOnline(false);
      }
    })();
    return () => ctrl.abort();
  }, []);

  const rawMode = searchParams.get('mode');
  const mode: PageMode = rawMode === 'demo' ? 'demo' : rawMode === 'local-2p' ? 'local-2p' : 'play';

  const setMode = (nextMode: PageMode) => {
    if (nextMode === 'play') setSearchParams({});
    else setSearchParams({ mode: nextMode });
  };

  if (isLoading) {
    return (
      <div className="sp-page">
        <div className="sp-card">
          <div className="sp-skeleton-header" />
          <div className="sp-game-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="sp-skeleton-card">
                <div className="sp-skeleton-preview" />
                <div className="sp-skeleton-body">
                  <div className="sp-skeleton-line sp-skeleton-line--title" />
                  <div className="sp-skeleton-line sp-skeleton-line--desc" />
                  <div className="sp-skeleton-line sp-skeleton-line--desc sp-skeleton-line--short" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }



  const LOCAL_2P_GAMES: GameCardItem[] = SINGLE_PLAYER_GAMES.filter(g => g.modes?.includes('2P'));

  const games = mode === 'demo' ? DEMO_GAMES : mode === 'local-2p' ? LOCAL_2P_GAMES : SINGLE_PLAYER_GAMES;
  const title = mode === 'demo' ? 'Pick a Demo Game' : mode === 'local-2p' ? 'Local 2-Player Games' : 'Pick a Single-Player Game';
  const subtitle = mode === 'demo'
    ? 'Watch CPU-driven matches with no sign-in required.'
    : mode === 'local-2p'
      ? 'All games below support pass-and-play on this device.'
      : 'Choose any game below and jump in.';

  const filteredGames = searchQuery.trim() === ''
    ? games
    : games.filter(g =>
        g.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        g.description.toLowerCase().includes(searchQuery.toLowerCase())
      );

  return (
    <div className="sp-page">
      {/* Offline banner — amber bar, auto-visible when API unreachable */}
      {apiOnline === false && (
        <div className="sp-offline-banner" role="alert">
          <WifiOff size={14} />
          Offline mode — scores won&apos;t sync until the server is reachable
        </div>
      )}

      <div className="sp-card">
        <div className="sp-header">
          <button className="sp-back" onClick={() => navigate('/')}>
            <ArrowLeft size={16} /> Home
          </button>
          <h1 className="sp-title">{title}</h1>
        </div>

        <div className="sp-auth-banner-actions" style={{ marginBottom: '1rem' }}>
          <button
            className={mode === 'play' ? 'sp-btn-primary' : 'sp-btn-secondary'}
            onClick={() => setMode('play')}
          >
            Play games
          </button>
          <button
            className={mode === 'local-2p' ? 'sp-btn-primary' : 'sp-btn-secondary'}
            onClick={() => setMode('local-2p')}
          >
            <Users size={13} /> Local 2P
          </button>
          <button
            className={mode === 'demo' ? 'sp-btn-primary' : 'sp-btn-secondary'}
            onClick={() => setMode('demo')}
          >
            Watch demos
          </button>
        </div>

        <p className="sp-subtitle">{subtitle}</p>

        {/* Search filter */}
        <div className="sp-search-wrap">
          <Search size={14} className="sp-search-icon" aria-hidden="true" />
          <input
            className="sp-search"
            type="search"
            placeholder="Search games…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            aria-label="Search games"
          />
        </div>

        <div className="sp-game-grid">
          {filteredGames.length > 0
            ? <GameCardGrid games={filteredGames} />
            : (
              <p className="sp-no-results">No games match &ldquo;{searchQuery}&rdquo;</p>
            )
          }
        </div>

        {/* Leaderboard — shown in play mode below the game grid */}
        {mode === 'play' && <HomeHighScores />}
      </div>
    </div>
  );
}
