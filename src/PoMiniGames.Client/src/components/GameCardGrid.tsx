import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

export interface GameCardItem {
  key: string;
  to: string;
  title: string;
  description: string;
  ariaLabel: string;
  accent: string;
  accentGlow: string;
  icon: ReactNode;
}

interface GameCardGridProps {
  games: readonly GameCardItem[];
}

/** Shared game card grid — used by SinglePlayerPage and MultiplayerPage. */
export function GameCardGrid({ games }: GameCardGridProps) {
  const navigate = useNavigate();
  return (
    <div className="sp-game-grid">
      {games.map((game, index) => (
        <button
          key={game.key}
          type="button"
          className="sp-game-card"
          aria-label={game.ariaLabel}
          style={{
            '--accent': game.accent,
            '--accent-glow': game.accentGlow,
            animationDelay: `${index * 0.06}s`,
          } as React.CSSProperties}
          onClick={() => navigate(game.to)}
        >
          <div className="sp-game-card-header" aria-hidden="true" />
          <div className="sp-game-card-body">
            <div className="sp-game-icon">{game.icon}</div>
            <h2>{game.title}</h2>
            <p>{game.description}</p>
          </div>
        </button>
      ))}
    </div>
  );
}
