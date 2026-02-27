import type { ReactNode } from 'react';
import './GamePageShell.css';

export interface StatItem {
  value: number | string;
  label: string;
}

interface GamePageShellProps {
  /** Left side: game title (can include icon) */
  title: ReactNode;
  /** Left side: player name badge */
  player?: string;
  /** Center: status badge (your turn, AI wins, etc.) */
  status?: ReactNode;
  /** Center: action controls (difficulty select, buttons) */
  controls?: ReactNode;
  /** Right side: compact stat items */
  stats?: StatItem[];
  /** Use true for canvas/iframe games — removes padding and clips overflow */
  fullscreen?: boolean;
  children: ReactNode;
}

export function GamePageShell({
  title,
  player,
  status,
  controls,
  stats,
  fullscreen = false,
  children,
}: GamePageShellProps) {
  return (
    <div className="gps-shell">
      <div className="gps-info-bar">
        {/* ── Left: title + player ────────────────────────── */}
        <div className="gps-info-left">
          <span className="gps-title">{title}</span>
          {player && <span className="gps-player">{player}</span>}
        </div>

        {/* ── Center: status + controls ───────────────────── */}
        {(status || controls) && (
          <div className="gps-info-center">
            {status}
            {controls && <div className="gps-controls">{controls}</div>}
          </div>
        )}

        {/* ── Right: stats ────────────────────────────────── */}
        {stats && stats.length > 0 && (
          <div className="gps-info-right">
            {stats.map((s) => (
              <div key={s.label} className="gps-stat">
                <span className="gps-stat-value">{s.value}</span>
                <span className="gps-stat-label">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Game area ─────────────────────────────────────── */}
      <div className={`gps-game-area${fullscreen ? ' gps-game-area--fullscreen' : ''}`}>
        {children}
      </div>
    </div>
  );
}
