import { NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { useEffect } from 'react';
import { Gamepad2, LogIn, LogOut, User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePlayerName } from '../context/PlayerNameContext';
import Toast, { showToast } from './Toast';
import './GameLayout.css';

export default function GameLayout() {
  const { error, isAuthenticated, isConfigured, isLoading, signIn, signOut, user } = useAuth();
  const { playerName, setPlayerName } = usePlayerName();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Show auth errors as a toast instead of an inline banner
  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error]);

  // Kiosk demo cycling: navigate back to /demo after 45 s so a new random game is picked
  useEffect(() => {
    if (!searchParams.get('demo_return')) return;
    const timer = window.setTimeout(() => {
      void navigate('/demo', { replace: true });
    }, 45_000);
    return () => window.clearTimeout(timer);
  }, [searchParams, navigate]);
  return (
    <div className="gl-page">
      <header className="gl-top-bar">
        <NavLink to="/" className="gl-brand">
          <span className="gl-brand-icon">
            <Gamepad2 size={16} />
          </span>
          <span className="gl-brand-text">PoMiniGames</span>
        </NavLink>

        <div className="gl-player-chip">
          <User size={11} className="gl-player-chip-icon" aria-hidden="true" />
          <input
            className="gl-player-input"
            value={playerName}
            onChange={e => setPlayerName(e.target.value)}
            aria-label="Player name"
            maxLength={20}
            placeholder="Your name"
            title="Set your player name"
          />
        </div>

        <div className="gl-auth">
          {isConfigured && user && (
            <span className="gl-auth-user" title={user.email ?? user.displayName}>
              {user.displayName}
            </span>
          )}
          {isConfigured && !isLoading && (
            <button className="gl-auth-button" onClick={isAuthenticated ? () => void signOut() : () => void signIn()}>
              {isAuthenticated ? <LogOut size={14} /> : <LogIn size={14} />}
              {isAuthenticated ? 'Sign out' : 'Sign in'}
            </button>
          )}
        </div>
      </header>

      <main className="gl-content">
        <Outlet />
      </main>
      <Toast />
    </div>
  );
}
