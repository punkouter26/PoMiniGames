import { useRef, useState, useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Home, RefreshCw, Settings, WifiOff } from 'lucide-react';
import { apiService } from './apiService';
import './GamePageShell.css';

export interface StatItem {
  value: number | string;
  label: string;
}

/** Pings the backend once on mount; re-checks every 15 s while the tab is visible.
 * For offline-first games, polling can be skipped and the badge shown immediately.
 */
function useIsOffline(skipPing = false): boolean {
  const [offline, setOffline] = useState(skipPing);
  useEffect(() => {
    if (skipPing) {
      setOffline(true);
      return;
    }

    let cancelled = false;
    const check = () =>
      apiService.isAvailable().then(ok => { if (!cancelled) setOffline(!ok); });

    void check();
    const id = window.setInterval(check, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [skipPing]);
  return offline;
}

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
  /** Route to navigate back to — renders a ← button */
  backTo?: string;
  /** Brief keyboard hint shown in info bar e.g. "WASD · ESC Pause" */
  keyboardHint?: string;
  /** Offline-first games can skip server status polling and just show the badge. */
  offlineFriendly?: boolean;
  /** When true, shows a "Play Again / Home" bar at the bottom */
  gameOver?: boolean;
  /** Called when user taps "Play Again" */
  onPlayAgain?: () => void;
  children: ReactNode;
}

export function GamePageShell({
  title,
  player,
  status,
  controls,
  stats,
  fullscreen = false,
  backTo,
  keyboardHint,
  offlineFriendly = false,
  gameOver = false,
  onPlayAgain,
  children,
}: GamePageShellProps) {
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const isOffline = useIsOffline(offlineFriendly);

  // Close drawer on outside click
  useEffect(() => {
    if (!drawerOpen) return;
    const handler = (e: MouseEvent) => {
      if (!drawerRef.current?.contains(e.target as Node)) {
        setDrawerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [drawerOpen]);

  // UX #10: Escape key navigates back
  useEffect(() => {
    if (!backTo) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !drawerOpen) {
        void navigate(backTo);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [backTo, navigate, drawerOpen]);

  const hasDrawerContent = !!(controls || (stats && stats.length > 0) || keyboardHint);

  return (
    <div className="gps-shell">
      <div className="gps-info-bar">
        {/* Left: back button + title + player */}
        <div className="gps-info-left">
          {backTo && (
            <button className="gps-back-btn" onClick={() => navigate(backTo)} aria-label="Go back">
              <ArrowLeft size={14} />
            </button>
          )}
          <span className="gps-title">{title}</span>
          {player && <span className="gps-player">{player}</span>}
        </div>

        {/* Center: status only */}
        {status && (
          <div className="gps-info-center">
            {status}
          </div>
        )}

        {/* Offline indicator — shown when the API is not reachable */}
        {isOffline && (
          <span className="gps-offline-badge" title="Server offline — scores won't sync">
            <WifiOff size={11} />
            Offline
          </span>
        )}

        {/* Right: settings gear + slide-out drawer for controls & stats */}
        {hasDrawerContent && (
          <div className="gps-settings-wrap" ref={drawerRef}>
            <button
              className={`gps-settings-btn${drawerOpen ? ' active' : ''}`}
              onClick={() => setDrawerOpen(v => !v)}
              aria-label="Game settings and stats"
              aria-expanded={drawerOpen}
            >
              <Settings size={15} />
            </button>

            {drawerOpen && (
              <div className="gps-settings-drawer" role="dialog" aria-label="Game settings">
                {stats && stats.length > 0 && (
                  <div className="gps-drawer-stats">
                    {stats.map((s) => (
                      <div key={s.label} className="gps-stat">
                        {/* keying on value causes React to remount the span, re-triggering pop animation */}
                        <span key={String(s.value)} className="gps-stat-value">{s.value}</span>
                        <span className="gps-stat-label">{s.label}</span>
                      </div>
                    ))}
                  </div>
                )}
                {controls && (
                  <div className="gps-drawer-controls gps-controls">{controls}</div>
                )}
                {keyboardHint && (
                  <div className="gps-drawer-kbd">{keyboardHint}</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Game area */}
      <div className={`gps-game-area${fullscreen ? ' gps-game-area--fullscreen' : ''}`}>
        {children}
      </div>

      {/* UX #6: Play Again bar — slides up when game ends */}
      {gameOver && (
        <div className="gps-play-again-bar" role="complementary" aria-label="Game over actions">
          {onPlayAgain && (
            <button className="gps-play-again-btn gps-play-again-btn--primary" onClick={onPlayAgain}>
              <RefreshCw size={15} /> Play Again
            </button>
          )}
          {backTo && (
            <button className="gps-play-again-btn gps-play-again-btn--secondary" onClick={() => void navigate(backTo)}>
              <Home size={15} /> Home
            </button>
          )}
        </div>
      )}
    </div>
  );
}
