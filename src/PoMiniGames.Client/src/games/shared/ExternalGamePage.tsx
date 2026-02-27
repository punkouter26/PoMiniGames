import { useState } from 'react';
import { ExternalLink, Trophy, XCircle, Handshake } from 'lucide-react';
import { Difficulty, GameResult } from './types';
import { statsService } from './statsService';
import { usePlayerName } from '../../context/PlayerNameContext';
import { GamePageShell, type StatItem } from './GamePageShell';
import './ExternalGamePage.css';

interface ExternalGamePageProps {
  gameKey: string;
  title: string;
  subtitle?: string;
  gameUrl?: string;
  gameUrlEnvVar: string;
}

export default function ExternalGamePage({
  gameKey,
  title,
  subtitle,
  gameUrl,
  gameUrlEnvVar,
}: ExternalGamePageProps) {
  const { playerName } = usePlayerName();
  const [difficulty, setDifficulty] = useState(Difficulty.Medium);
  const [stats, setStats] = useState(() => statsService.getStats(gameKey, playerName));

  const hasGameUrl = Boolean(gameUrl && gameUrl.trim().length > 0);
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
      {hasGameUrl ? (
        <iframe
          title={title}
          src={gameUrl}
          className="external-game-frame"
          loading="lazy"
        />
      ) : (
        <div className="gps-missing-url">
          Configure <strong>{gameUrlEnvVar}</strong> in your PoMiniGames client environment to embed this game.
        </div>
      )}
    </GamePageShell>
  );
}
