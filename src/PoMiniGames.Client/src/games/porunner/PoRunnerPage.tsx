import './porunner.css';
import { useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { GamePageShell } from '../shared/GamePageShell';
import { initUI, detectMobile } from './ui';
import { loadAssets } from './assets';
import { start as startSignalR } from './signalr';
import { updateDemo, startDemo } from './demo';
import { render, update, initCanvas } from './renderer';
import { state } from './state';
import { initInput } from './input';
import type { GameMode } from './constants';

// Inject the mode into the global scope BEFORE any game module loads
declare global {
  interface Window {
    __poRunnerMode?: GameMode;
  }
}

export default function PoRunnerPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const startedRef = useRef(false);

  const mode = (searchParams.get('mode') as GameMode) || '1p';

  const handleBack = useCallback(() => {
    navigate('/single-player');
  }, [navigate]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // Set mode before any game modules initialize
    window.__poRunnerMode = mode;

    // Setup
    initUI();
    detectMobile();

    if (canvasRef.current) {
      initCanvas(canvasRef.current);
    }

    // For demo mode, skip SignalR and auto-start
    if (mode === 'demo') {
      loadAssets().then(() => {
        startDemo();
      });
    } else if (mode === '1p' || mode === '2p') {
      // Local modes: set up local players and auto-start
      loadAssets().then(() => {
        // Create local player(s)
        if (mode === '1p') {
          state.connectionId = 'local_p1';
          state.serverPlayers['local_p1'] = {
            id: 'local_p1',
            x: 150,
            y: 4,
            direction: 'east',
            action: 'idle',
            currentFrame: 0,
            colorTint: 'yellow',
            isReady: true,
          };
        } else if (mode === '2p') {
          state.connectionId = 'local_p1';
          state.serverPlayers['local_p1'] = {
            id: 'local_p1',
            x: 150,
            y: 3,
            direction: 'east',
            action: 'idle',
            currentFrame: 0,
            colorTint: 'yellow',
            isReady: true,
          };
          state.serverPlayers['local_p2'] = {
            id: 'local_p2',
            x: 150,
            y: 5,
            direction: 'east',
            action: 'idle',
            currentFrame: 0,
            colorTint: 'blue',
            isReady: true,
          };
        }
        state.gameStatus = 'waiting';
      });
    } else {
      // Multiplayer: fire-and-forget SignalR connection
      loadAssets().then(() => {
        startSignalR();
      });
    }

    // Keyboard input
    initInput();

    // Game loop
    let lastTime = performance.now();
    function loop(time: number) {
      const dt = (time - lastTime) / 1000;
      lastTime = time;
      if (dt < 0.1) {
        updateDemo(dt);
        update(dt);
      }
      render();
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [mode]);

  return (
    <GamePageShell
      title="🍌 PoRunner"
      fullscreen
      backTo="/single-player"
      keyboardHint="T-Y-G-H · Enter to race"
    >
      <div id="game-container" style={{ position: 'relative', width: '100%', height: '100%' }}>
        <canvas
          ref={canvasRef}
          id="gameCanvas"
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            imageRendering: 'pixelated',
          }}
        />

        {/* Mobile keyboard warning */}
        <div id="mobile-warning" className="mobile-warning hidden">
          ⌨️ PoRunner requires a keyboard — best played on desktop.
        </div>

        {/* Error Screen */}
        <div id="ui-error" className="screen hidden">
          <div className="glassmorphism" style={{ textAlign: 'center' }}>
            <h2 id="error-title">⚠️ Connection Error</h2>
            <p id="error-message">Unable to connect to server.</p>
            <button id="btn-reconnect" className="btn primary pulse">RECONNECT</button>
          </div>
        </div>

        {/* Unified Lobby Screen */}
        <div id="ui-lobby" className="screen hidden">
          <div className="glassmorphism" style={{ textAlign: 'center' }}>
            <h1 className="glow-text">🍌 PoRunner</h1>

            <div id="player-badge" className="player-badge hidden">
              <span id="player-badge-icon">🍌</span>
              <span id="player-badge-label">YOU ARE: YELLOW</span>
            </div>

            <div id="lobby-slots" className="lobby-slots"></div>

            <div className="spinner" id="lobby-spinner"></div>
            <p id="lobby-status-line" className="blink">Looking for an opponent&hellip;</p>

            <p id="lobby-connection-warning" className="connection-warning hidden"></p>

            <button id="btn-ready" className="btn primary">RACE SOLO!</button>
            <p id="ready-status-text" className="status-text hidden">✅ Ready! Waiting for opponent&hellip;</p>

            <div className="lobby-leaderboard">
              <p className="leaderboard-title">🏅 Top Scores</p>
              <table className="leaderboard-table">
                <tbody id="lobby-leaderboard-body">
                  <tr><td colSpan={3} style={{ opacity: 0.5, padding: '0.5rem 0' }}>Connecting…</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Countdown Screen */}
        <div id="ui-countdown" className="screen hidden">
          <p id="countdown-text" className="huge-text glow-text">3</p>
        </div>

        {/* Playing HUD */}
        <div id="ui-playing" className="hud hidden">
          <div id="hud-timer" className="time-score">0.000s</div>
          <div id="controls-hint" className="controls-hint">
            <div className="icon-keyboard">⌨️</div>
            <p id="combo-display">
              Type{' '}
              <span id="combo-T" className="combo-key next">T</span>{' '}
              <span id="combo-Y" className="combo-key">Y</span>{' '}
              <span id="combo-G" className="combo-key">G</span>{' '}
              <span id="combo-H" className="combo-key">H</span>{' '}
              to run!
            </p>
          </div>
        </div>

        {/* Game Over Screen */}
        <div id="ui-gameover" className="screen shadow-bg hidden">
          <div className="glassmorphism gameover-card" style={{ textAlign: 'center' }}>
            <div id="gameover-icon" className="gameover-icon">🏆</div>
            <h2 id="winner-text" className="glow-text winner-reveal">YELLOW WINS!</h2>
            <div id="final-time-text" className="time-score">0.000s</div>
            <button id="btn-restart" className="btn primary pulse sticky-cta" onClick={handleBack}>
              RETURN TO LOBBY
            </button>

            <div id="gameover-details" className="gameover-details">
              <div id="player-stats" className="player-stats hidden">
                <div className="stats-row">
                  <span className="stats-label">Personal Best</span>
                  <span id="stats-pb" className="stats-value">—</span>
                </div>
                <div className="stats-row">
                  <span className="stats-label">Wins</span>
                  <span id="stats-wins" className="stats-value accent">0</span>
                  <span className="stats-sep">│</span>
                  <span className="stats-label">Losses</span>
                  <span id="stats-losses" className="stats-value muted">0</span>
                </div>
                <div className="stats-row">
                  <span className="stats-label">Best Streak</span>
                  <span id="stats-streak" className="stats-value">0</span>
                  <span id="stats-streak-fire" className="hidden">🔥</span>
                </div>
              </div>

              <div id="initials-form" className="initials-form hidden">
                <h3 className="initials-title">🏅 New High Score! Enter Initials</h3>
                <div className="initials-boxes">
                  <input id="initial-0" className="initial-box" type="text" maxLength={1} autoComplete="off" spellCheck="false" inputMode="text" />
                  <input id="initial-1" className="initial-box" type="text" maxLength={1} autoComplete="off" spellCheck="false" inputMode="text" />
                  <input id="initial-2" className="initial-box" type="text" maxLength={1} autoComplete="off" spellCheck="false" inputMode="text" />
                </div>
                <button id="btn-submit-initials" className="btn primary">SUBMIT</button>
              </div>

              <div id="leaderboard" className="leaderboard">
                <button id="btn-toggle-leaderboard" className="btn-leaderboard-toggle">🏅 View Top 10 ▸</button>
                <div id="leaderboard-body-wrap" className="leaderboard-body-wrap hidden">
                  <table className="leaderboard-table">
                    <thead>
                      <tr>
                        <th className="leaderboard-rank"></th>
                        <th className="leaderboard-initials-header">Name</th>
                        <th className="leaderboard-time-header">Time</th>
                      </tr>
                    </thead>
                    <tbody id="leaderboard-body">
                      <tr><td colSpan={3} style={{ opacity: 0.5, padding: '0.5rem' }}>Loading…</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </GamePageShell>
  );
}