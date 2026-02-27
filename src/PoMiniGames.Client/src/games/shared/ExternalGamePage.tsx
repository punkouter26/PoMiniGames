import { useState, useEffect, useRef } from 'react';
import { ExternalLink, Trophy, XCircle, Handshake, Loader2, ServerOff, RefreshCw } from 'lucide-react';
import { Difficulty, GameResult } from './types';
import { statsService } from './statsService';
import { usePlayerName } from '../../context/PlayerNameContext';
import { GamePageShell, type StatItem } from './GamePageShell';
import './ExternalGamePage.css';

type ServerStatus = 'checking' | 'online' | 'offline';

interface ExternalGamePageProps {
  gameKey: string;
  title: string;
  subtitle?: string;
  gameUrl?: string;
  gameUrlEnvVar: string;
}

function useServerStatus(gameUrl: string | undefined): [ServerStatus, () => void] {
  const [status, setStatus] = useState<ServerStatus>('checking');
  const counterRef = useRef(0);

  const check = () => {
    if (!gameUrl) return;
    const id = ++counterRef.current;
    setStatus('checking');
    fetch(gameUrl, { mode: 'no-cors', cache: 'no-store' })
      .then(() => { if (counterRef.current === id) setStatus('online'); })
      .catch(() => { if (counterRef.current === id) setStatus('offline'); });
  };

  useEffect(() => {
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameUrl]);

  return [status, check];
}

export default function ExternalGamePage({
  gameKey,
  title,
  gameUrl,
  gameUrlEnvVar,
}: ExternalGamePageProps) {
  const { playerName } = usePlayerName();
  const [difficulty, setDifficulty] = useState(Difficulty.Medium);
  const [stats, setStats] = useState(() => statsService.getStats(gameKey, playerName));

  const hasGameUrl = Boolean(gameUrl && gameUrl.trim().length > 0);
  const [serverStatus, retryCheck] = useServerStatus(hasGameUrl ? gameUrl : undefined);
  const diffBucket = statsService.getDifficultyBucket(stats, difficulty);

  const recordResult = async (result: GameResult) => {
    const updated = await statsService.recordResult(gameKey, playerName, difficulty, result);
    setStats(updated);
  };

  const statItems: StatItem[] = [
    { value: diffBucket.wins, label: 'W' },
    { value: diffBucket.losses, label: 'L' },
    { value: diffBucket.draws, label: 'D' },
    { value: diffBucket.winStreak, label: 'Str' },
    { value: `${(diffBucket.winRate * 100).toFixed(0)}%`, label: 'Rate' },
  ];

  function renderGameArea() {
    if (!hasGameUrl) {
      return (
        <div className="egp-missing-url">
          Configure <strong>{gameUrlEnvVar}</strong> in your PoMiniGames client environment to embed this game.
        </div>
      );
    }
    if (serverStatus === 'checking') {
      return (
        <div className="egp-status">
          <Loader2 size={32} className="egp-spin" />
          <p>Connecting to game server…</p>
        </div>
      );
    }
    if (serverStatus === 'offline') {
      return (
        <div className="egp-status egp-offline">
          <ServerOff size={40} />
          <p className="egp-status-title">Game server not running</p>
          <p className="egp-status-sub">
            Start the <strong>{title}</strong> server at{' '}
            <code>{gameUrl}</code>, then retry.
          </p>
          <button className="egp-retry" onClick={retryCheck}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      );
    }
    return (
      <iframe
        title={title}
        src={gameUrl}
        className="external-game-frame"
        loading="lazy"
      />
    );
  }

  return (
    <GamePageShell
      title={title}
      player={playerName}
      controls={
        <>
          <select
            id={`${gameKey}-difficulty`}
            value={difficulty}
            onChange={(event) => setDifficulty(event.target.value as Difficulty)}
          >
            <option value={Difficulty.Easy}>Easy</option>
            <option value={Difficulty.Medium}>Medium</option>
            <option value={Difficulty.Hard}>Hard</option>
          </select>
          <button className="btn-win" onClick={() => recordResult(GameResult.Win)}>
            <Trophy size={12} /> Win
          </button>
          <button className="btn-loss" onClick={() => recordResult(GameResult.Loss)}>
            <XCircle size={12} /> Loss
          </button>
          <button className="btn-draw" onClick={() => recordResult(GameResult.Draw)}>
            <Handshake size={12} /> Draw
          </button>
          {hasGameUrl && (
            <a href={gameUrl} target="_blank" rel="noreferrer" className="gps-open-link">
              <ExternalLink size={12} /> Open in new tab
            </a>
          )}
        </>
      }
      stats={statItems}
      fullscreen={hasGameUrl}
    >
      {renderGameArea()}
    </GamePageShell>
  );
}
