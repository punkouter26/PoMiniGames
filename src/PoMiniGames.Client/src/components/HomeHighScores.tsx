import { useEffect, useState, useCallback, useRef } from 'react';
import { Trophy } from 'lucide-react';
import { apiService } from '../games/shared/apiService';
import { localStorageService } from '../games/shared/localStorageService';
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
type Difficulty = 'all' | 'easy' | 'medium' | 'hard';

const DIFFICULTIES: { id: Difficulty; label: string }[] = [
  { id: 'all',    label: 'All' },
  { id: 'easy',   label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard',   label: 'Hard' },
];

type CacheKey = `${GameId}:${Difficulty}`;

function cacheKey(game: GameId, diff: Difficulty): CacheKey {
  return `${game}:${diff}`;
}

function getRowMetric(entry: PlayerStatsDto, diff: Difficulty): { label: string; barFraction: number } {
  if (diff === 'all') {
    const pct = Math.round((entry.stats.winRate ?? 0) * 100);
    return { label: `${pct}% · ${entry.stats.totalGames}G`, barFraction: entry.stats.winRate ?? 0 };
  }
  const bucket = entry.stats[diff];
  const elo = bucket?.eloRating ?? 1000;
  const games = bucket?.totalGames ?? 0;
  return { label: `ELO ${elo} · ${games}G`, barFraction: Math.min(elo / 2000, 1) };
}

export default function HomeHighScores() {
  const [activeTab, setActiveTab] = useState<GameId>(GAMES[0].id);
  const [activeDiff, setActiveDiff] = useState<Difficulty>('all');
  const [showDifficultyFilters, setShowDifficultyFilters] = useState(false);
  const [cache, setCache] = useState<Partial<Record<CacheKey, PlayerStatsDto[]>>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const loadedRef = useRef<Set<CacheKey>>(new Set());

  useEffect(() => {
    let mounted = true;
    apiService.isAvailable().then(ok => { if (mounted) setApiAvailable(ok); });
    return () => { mounted = false; };
  }, []);

  const loadCombo = useCallback(async (id: GameId, diff: Difficulty) => {
    const key = cacheKey(id, diff);
    if (!cache[key]) {
      const localDiff = diff !== 'all' ? diff : undefined;
      const localEntries = localStorageService
        .getLeaderboard(id, 10, localDiff)
        .map(({ name, stats }) => ({ name, game: id, stats }) satisfies PlayerStatsDto);
      setCache(prev => ({ ...prev, [key]: localEntries }));
    }
    if (apiAvailable === false || apiAvailable === null) return;
    if (loadedRef.current.has(key)) return;
    loadedRef.current.add(key);
    setIsLoading(true);
    const entries = await apiService.getLeaderboard(id, 10, diff);
    if (entries !== null) setCache(prev => ({ ...prev, [key]: entries }));
    setIsLoading(false);
  }, [apiAvailable, cache]);

  useEffect(() => {
    void loadCombo(activeTab, activeDiff);
  }, [activeTab, activeDiff, loadCombo]);

  const key = cacheKey(activeTab, activeDiff);
  const rawEntries = cache[key] ?? null;
  const entries = rawEntries && rawEntries.length === 0 ? null : rawEntries;
  const topBarFraction = entries && entries.length > 0
    ? Math.max(...entries.map(e => getRowMetric(e, activeDiff).barFraction))
    : 1;

  return (
    <section id="highscores" className="home-highscores" aria-label="Top 10 high scores per game">
      <div className="home-highscores-heading">
        <h2 className="home-highscores-title">
          <Trophy size={20} />
          Top 10 High Scores
        </h2>
        <button
          type="button"
          className="home-highscores-filter-toggle"
          onClick={() => setShowDifficultyFilters(v => !v)}
        >
          {showDifficultyFilters ? 'Hide difficulty' : 'Filter by difficulty'}
        </button>
      </div>

      <div className="home-highscores-tabs" role="tablist" aria-label="Game">
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

      {showDifficultyFilters && (
        <div className="home-highscores-diff-tabs" role="tablist" aria-label="Difficulty">
          {DIFFICULTIES.map(d => (
            <button
              key={d.id}
              role="tab"
              aria-selected={activeDiff === d.id}
              className={`home-highscores-diff-tab${activeDiff === d.id ? ' active' : ''}`}
              onClick={() => setActiveDiff(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}

      <div className="home-highscores-panel" role="tabpanel">
        {isLoading && entries === null ? (
          <p className="home-highscores-empty">Loading...</p>
        ) : entries === null ? (
          <ol className="home-highscores-list">
            {Array.from({ length: 10 }, (_, i) => (
              <li key={i} className="home-highscores-row home-highscores-row--empty">
                <span className="home-highscores-rank">#{i + 1}</span>
                <div className="home-highscores-info">
                  <span className="home-highscores-name">---</span>
                  <div className="home-highscores-bar-wrap">
                    <div className="home-highscores-bar" style={{ '--bar-w': '0%', '--bar-delay': `${i * 60}ms` } as React.CSSProperties} />
                  </div>
                </div>
                <span className="home-highscores-metric">
                  {activeDiff === 'all' ? '0% · 0G' : 'ELO 1000 · 0G'}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <ol className="home-highscores-list">
            {entries.map((entry, index) => {
              const { label: metricLabel, barFraction } = getRowMetric(entry, activeDiff);
              const barWidth = topBarFraction > 0 ? Math.round((barFraction / topBarFraction) * 100) : 0;
              const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : null;
              return (
                <li
                  key={`${activeTab}-${activeDiff}-${entry.name}-${entry.stats.playerId}-${index}`}
                  className={`home-highscores-row${medal ? ` home-highscores-row--rank${index + 1}` : ''}`}
                >
                  <span className="home-highscores-rank">{medal ?? `#${index + 1}`}</span>
                  <div className="home-highscores-info">
                    <span className="home-highscores-name">{entry.name}</span>
                    <div className="home-highscores-bar-wrap">
                      <div
                        className="home-highscores-bar"
                        style={{ '--bar-w': `${barWidth}%`, '--bar-delay': `${index * 60}ms` } as React.CSSProperties}
                      />
                    </div>
                  </div>
                  <span className="home-highscores-metric">{metricLabel}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

