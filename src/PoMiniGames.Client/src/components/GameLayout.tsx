import { Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { Gamepad2, LogIn, LogOut, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import Toast, { showToast } from './Toast';
import './GameLayout.css';

const DEMO_ROTATION = [
  { path: '/tictactoe', label: 'Tic Tac Toe' },
  { path: '/connectfive', label: 'Connect Five' },
  { path: '/pofight', label: 'PoFight' },
] as const;

const DEMO_ROTATION_SECS = 60;

function buildDemoRotationUrl(idx: number): string {
  const game = DEMO_ROTATION[idx % DEMO_ROTATION.length]!;
  return `${game.path}?demo=1&demo_rotation=1&demo_idx=${idx % DEMO_ROTATION.length}`;
}

/** Overlay bar shown during the kiosk demo rotation. */
function DemoRotationBar({ currentIdx, onStop }: { currentIdx: number; onStop: () => void }) {
  const navigate = useNavigate();
  const [secsLeft, setSecsLeft] = useState(DEMO_ROTATION_SECS);
  const gameName = DEMO_ROTATION[currentIdx % DEMO_ROTATION.length]!.label;
  const nextIdx = (currentIdx + 1) % DEMO_ROTATION.length;
  const nextName = DEMO_ROTATION[nextIdx]!.label;

  useEffect(() => {
    setSecsLeft(DEMO_ROTATION_SECS); // reset when game changes
  }, [currentIdx]);

  useEffect(() => {
    if (secsLeft <= 0) {
      void navigate(buildDemoRotationUrl(currentIdx + 1), { replace: true });
      return;
    }
    const id = window.setTimeout(() => setSecsLeft(s => s - 1), 1_000);
    return () => window.clearTimeout(id);
  }, [secsLeft, currentIdx, navigate]);

  const pct = ((DEMO_ROTATION_SECS - secsLeft) / DEMO_ROTATION_SECS) * 100;

  return (
    <div className="demo-bar" role="status" aria-live="polite">
      <div className="demo-bar__progress" style={{ width: `${pct}%` }} />
      <span className="demo-bar__label">
        <span className="demo-bar__dot" aria-hidden="true" />
        Demo&nbsp;—&nbsp;<strong>{gameName}</strong>
      </span>
      <span className="demo-bar__next">
        Next: {nextName} in {secsLeft}s
      </span>
      <button className="demo-bar__stop" onClick={onStop} aria-label="Stop demo mode">
        <X size={13} />
        Stop Demo
      </button>
    </div>
  );
}

const DEMO_ROUTES_LEGACY = [
  '/tictactoe?demo=1&demo_return=1',
  '/connectfive?demo=1&demo_return=1',
  '/pofight?demo=1&demo_return=1',
] as const;

function pickRandomDemoRoute(): string {
  return DEMO_ROUTES_LEGACY[Math.floor(Math.random() * DEMO_ROUTES_LEGACY.length)]!;
}

export default function GameLayout() {
  const { error, isAuthenticated, isConfigured, isLoading, signIn, signOut, user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const isDemoRotation = searchParams.get('demo_rotation') === '1';
  const demoIdx = parseInt(searchParams.get('demo_idx') ?? '0', 10);

  // Show auth errors as a toast instead of an inline banner
  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error]);

  // Legacy random cycling for individual demo links (demo_return=1 without demo_rotation)
  useEffect(() => {
    if (!searchParams.get('demo_return') || isDemoRotation) return;
    const timer = window.setTimeout(() => {
      void navigate(pickRandomDemoRoute(), { replace: true });
    }, 60_000);
    return () => window.clearTimeout(timer);
  }, [searchParams, navigate, isDemoRotation]);

  return (
    <div className="gl-page">
      <header className="gl-top-bar">
        <NavLink to="/" className="gl-brand">
          <span className="gl-brand-icon">
            <Gamepad2 size={16} />
          </span>
          <span className="gl-brand-text">PoMiniGames</span>
        </NavLink>

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
        <Suspense fallback={<div className="flex items-center justify-center min-h-screen text-white/60">Loading…</div>}>
          <Outlet />
        </Suspense>
      </main>
      {isDemoRotation && (
        <DemoRotationBar
          currentIdx={demoIdx}
          onStop={() => void navigate('/', { replace: true })}
        />
      )}
      <Toast />
    </div>
  );
}
