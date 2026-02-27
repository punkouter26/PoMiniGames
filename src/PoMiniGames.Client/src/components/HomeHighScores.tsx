import { useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import { apiService } from '../games/shared/apiService';
import type { PlayerStatsDto } from '../games/shared/types';
import './HomeHighScores.css';

const GAMES = [
  { id: 'connectfive', label: 'Connect Five' },
  { id: 'tictactoe', label: 'Tic Tac Toe' },
  { id: 'voxelshooter', label: 'Voxel Shooter' },
  { id: 'pofight', label: 'PoFight' },
  { id: 'podropsquare', label: 'PoDropSquare' },
  { id: 'pobabytouch', label: 'PoBabyTouch' },
  { id: 'poraceragdoll', label: 'PoRaceRagdoll' },
  // PoSnakeGame has its own score-based leaderboard on the game page
] as const;

function toPercent(value: number | undefined): string {
  return `${Math.round((value ?? 0) * 100)}%`;
}

export default function HomeHighScores() {
  const [leaderboards, setLeaderboards] = useState<Record<string, PlayerStatsDto[]>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      setIsLoading(true);
      const results = await Promise.all(
        GAMES.map(async (game) => ({
          gameId: game.id,
          entries: (await apiService.getLeaderboard(game.id, 10)) ?? [],
        })),
      );

      if (!mounted) return;

      const next: Record<string, PlayerStatsDto[]> = {};
      for (const result of results) {
        next[result.gameId] = result.entries;
      }

      setLeaderboards(next);
      setIsLoading(false);
    };

    void load();

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <section className="home-highscores" aria-label="Top 10 high scores per game">
      <h2 className="home-highscores-title">
        <Trophy size={20} />
        Top 10 High Scores
      </h2>

      {isLoading ? (
        <p className="home-highscores-empty">Loading high scores...</p>
      ) : (
        <div className="home-highscores-grid">
          {GAMES.map((game) => {
            const entries = leaderboards[game.id] ?? [];
            return (
              <article key={game.id} className="home-highscores-card">
                <h3 className="home-highscores-game">{game.label}</h3>

                {entries.length === 0 ? (
                  <p className="home-highscores-empty">No entries yet.</p>
                ) : (
                  <ol className="home-highscores-list">
                    {entries.map((entry, index) => (
                      <li
                        key={`${game.id}-${entry.name}-${entry.stats.playerId}-${index}`}
                        className="home-highscores-row"
                      >
                        <span className="home-highscores-rank">#{index + 1}</span>
                        <span className="home-highscores-name">{entry.name}</span>
                        <span className="home-highscores-metric">
                          {toPercent(entry.stats.overallWinRate)} • {entry.stats.totalGames}G • {entry.stats.totalWins}W
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
