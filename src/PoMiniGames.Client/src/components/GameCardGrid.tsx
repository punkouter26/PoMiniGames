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
  /** Which modes this game supports: '1P', '2P', 'Demo' */
  modes?: Array<'1P' | '2P' | 'Demo'>;
}

interface GameCardGridProps {
  games: readonly GameCardItem[];
}

/** Shared game card grid for the simplified game-pick screens. */
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
            '--row-index': index,
            animationDelay: `${index * 0.06}s`,
          } as React.CSSProperties}
          onClick={() => navigate(game.to)}
        >
          <div className="sp-game-card-preview" aria-hidden="true">
            <div className="sp-game-icon">{game.icon}</div>
          </div>
          <div className="sp-game-card-body">
            <h2>{game.title}</h2>
            <p>{game.description}</p>
            {game.modes && game.modes.length > 0 && (
              <div className="sp-game-modes" aria-label="Available modes">
                {game.modes.map(m => (
                  <span
                    key={m}
                    className={`sp-mode-pill sp-mode-pill--${m.toLowerCase()}`}
                  >
                    {m}
                  </span>
                ))}
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
