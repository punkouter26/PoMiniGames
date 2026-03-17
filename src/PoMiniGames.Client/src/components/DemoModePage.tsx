import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Loader2 } from 'lucide-react';
import './DemoModePage.css';

const DEMO_ROUTES = ['/tictactoe?demo=1', '/connectfive?demo=1', '/pofight?demo=1'] as const;
const DEMO_CYCLE_MS = 45_000;

function pickRandomDemoRoute() {
  const randomIndex = Math.floor(Math.random() * DEMO_ROUTES.length);
  const base = DEMO_ROUTES[randomIndex]!;
  return `${base}&demo_return=1`;
}

export default function DemoModePage() {
  const navigate = useNavigate();
  const destination = useMemo(() => pickRandomDemoRoute(), []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void navigate(destination, { replace: true });
    }, 500);

    return () => window.clearTimeout(timer);
  }, [destination, navigate]);

  return (
    <div className="demo-page">
      <div className="demo-card">
        <Bot size={44} className="demo-icon" />
        <h1>DEMO MODE</h1>
        <p>Selecting a random game and launching CPU vs CPU...</p>
        <p className="demo-hint">Games cycle automatically every {DEMO_CYCLE_MS / 1000}s</p>
        <div className="demo-loading">
          <Loader2 size={16} className="demo-spin" />
          Redirecting...
        </div>
      </div>
    </div>
  );
}
