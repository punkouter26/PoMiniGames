import { useEffect, useState, useCallback, useRef } from 'react';
import { Trophy } from 'lucide-react';
import { apiService } from '../games/shared/apiService';
import type { PlayerStatsDto } from '../games/shared/types';
import './HomeHighScores.css';

const GAMES = [
  { id: 'connectfive',   label: 'Connect Five' },
  { id: 'tictactoe',     label: 'Tic Tac Toe' },
  { id: 'pofight',       label: 'PoFight' },
  { id: 'posnakegame',   label: 'PoSnakeGame' },
  { id: 'pobabytouch',   label: 'PoBabyTouch' },
  { id: 'podropsquare',  label: 'PoDropSquare' },
  { id: 'voxelshooter',  label: 'Voxel Shooter' },
  { id: 'poraceragdoll', label: 'PoRaceRagdoll' },
] as const;

type GameId = typeof GAMES[number]['id'];

export default function HomeHighScores() {
  const [activeTab, setActiveTab] = useState<GameId>(GAMES[0].id);
  const [cache, setCache] = useState<Partial<Record<GameId, PlayerStatsDto[]>>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const loadedRef = useRef<Set<GameId>>(new Set());

  // Check API availability once on mount
  useEffect(() => {
    let mounted = true;
    apiService.isAvailable().then(ok => { if (mounted) setApiAvailable(ok); });
    return () => { mounted = false; };
  }, []);

  const loadTab = useCallback(async (id: GameId) => {
    if (apiAvailable === false) {
      setCache(prev => ({ ...prev, [id]: [] }));
      return;
    }
    if (apiAvailable === null) return; // availability check not done yet
    if (loadedRef.current.has(id)) return; // already loaded

    loadedRef.current.add(id);
    setIsLoading(true);
    const entries = (await apiService.getLeaderboard(id, 10)) ?? [];
    setCache(prev => ({ ...prev, [id]: entries }));
    setIsLoading(false);
  }, [apiAvailable]);

  useEffect(() => {
    void loadTab(activeTab);
  }, [activeTab, loadTab]);

  const rawEntries = cache[activeTab] ?? null;
  const entries = rawEntries && rawEntries.length === 0 ? null : rawEntries;
  const topWinRate = entries && entries.length > 0
    ? Math.max(...entries.map(e => e.stats.winRate ?? 0))
    : 1;

  return (
    <section className="home-highscores" aria-label="Top 10 high scores per game">
      <h2 className="home-highscores-title">
        <Trophy size={20} />
        Top 10 High Scores
      </h2>

      {/* Tab pills */}
      <div className="home-highscores-tabs" role="tablist">
        {GAMES.map(game => (
          <button
            key={game.id}
            role="tab"
            aria-selected={activeTab === game.id}
            className={`home-highscores-tab${activeTab === game.id ? ' active' : ''}`}
            onClick={() => setActiveTab(game.id)}
          >
            {game.label}
          </button>
        ))}
      </div>

      {/* Leaderboard panel */}
      <div className="home-highscores-panel" role="tabpanel">
        {apiAvailable === null || (isLoading && entries === null) ? (
          <p className="home-highscores-empty">Loading...</p>
        ) : entries === null ? (
          // No entries yet — show 10 placeholder rows with zero scores
          <ol className="home-highscores-list">
            {Array.from({ length: 10 }, (_, i) => (
              <li key={i} className="home-highscores-row home-highscores-row--empty">
                <span className="home-highscores-rank">#{i + 1}</span>
                <div className="home-highscores-info">
                  <span className="home-highscores-name">---</span>
                  <div className="home-highscores-bar-wrap">
                    <div className="home-highscores-bar" style={{ '--bar-w': '0%' } as React.CSSProperties} />
                  </div>
                </div>
                <span className="home-highscores-metric">0% · 0G</span>
              </li>
            ))}
          </ol>
        ) : (
          <ol className="home-highscores-list">
            {entries.map((entry, index) => {
              const pct = Math.round((entry.stats.winRate ?? 0) * 100);
              const barWidth = topWinRate > 0 ? Math.round(((entry.stats.winRate ?? 0) / topWinRate) * 100) : 0;
              const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : null;
              return (
                <li
                  key={`${activeTab}-${entry.name}-${entry.stats.playerId}-${index}`}
                  className={`home-highscores-row${medal ? ` home-highscores-row--rank${index + 1}` : ''}`}
                >
                  <span className="home-highscores-rank">
                    {medal ?? `#${index + 1}`}
                  </span>
                  <div className="home-highscores-info">
                    <span className="home-highscores-name">{entry.name}</span>
                    <div className="home-highscores-bar-wrap">
                      <div
                        className="home-highscores-bar"
                        style={{ '--bar-w': `${barWidth}%` } as React.CSSProperties}
                      />
                    </div>
                  </div>
                  <span className="home-highscores-metric">
                    {pct}% · {entry.stats.totalGames}G
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
