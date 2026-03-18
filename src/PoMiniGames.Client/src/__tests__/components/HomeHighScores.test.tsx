import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { PlayerStatsDto } from '../../games/shared/types';
import HomeHighScores from '../../components/HomeHighScores';

// Mock the apiService so these tests never hit the network
vi.mock('../../games/shared/apiService', () => ({
  apiService: {
    isAvailable: vi.fn(),
    getLeaderboard: vi.fn(),
  },
}));

// Import the mocked version so we can set return values per test
const { apiService } = await import('../../games/shared/apiService');
const mockIsAvailable = vi.mocked(apiService.isAvailable);
const mockGetLeaderboard = vi.mocked(apiService.getLeaderboard);

// Reset mocks between every test so call-count assertions stay isolated
beforeEach(() => {
  vi.clearAllMocks();
  mockIsAvailable.mockResolvedValue(true);
});

const GAME_IDS = [
  'connectfive',
  'tictactoe',
  'voxelshooter',
  'pofight',
  'podropsquare',
  'pobabytouch',
  'poraceragdoll',
  'posnakegame',
] as const;

const GAME_LABELS = [
  'Connect Five',
  'Tic Tac Toe',
  'Voxel Shooter',
  'PoFight',
  'PoDropSquare',
  'PoBabyTouch',
  'PoRaceRagdoll',
  'PoSnakeGame',
];

function makeEntry(name: string, wins: number, total: number): PlayerStatsDto {
  const rate = total > 0 ? wins / total : 0;
  return {
    name,
    game: 'test',
    stats: {
      playerId: `id-${name}`,
      playerName: name,
      easy: { wins, losses: total - wins, draws: 0, totalGames: total, winStreak: 0, winRate: rate },
      medium: { wins: 0, losses: 0, draws: 0, totalGames: 0, winStreak: 0, winRate: 0 },
      hard: { wins: 0, losses: 0, draws: 0, totalGames: 0, winStreak: 0, winRate: 0 },
      totalWins: wins,
      totalLosses: total - wins,
      totalDraws: 0,
      totalGames: total,
      winRate: rate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

describe('HomeHighScores – loading state', () => {
  it('shows "Loading..." before data arrives', () => {
    // Never resolves so component stays in loading state
    mockIsAvailable.mockReturnValue(new Promise(() => {}));
    render(<HomeHighScores />);
    expect(screen.getByText(/Loading\.{3}/)).toBeInTheDocument();
  });

  it('removes loading text once data arrives', async () => {
    mockGetLeaderboard.mockResolvedValue([]);
    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading high scores/i)).not.toBeInTheDocument();
    });
  });
});

describe('HomeHighScores – section heading', () => {
  beforeEach(() => {
    mockGetLeaderboard.mockResolvedValue([]);
  });

  it('renders the "Top 10 High Scores" heading', async () => {
    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.getByText(/Top 10 High Scores/i)).toBeInTheDocument();
    });
  });

  it('has the accessible section label', async () => {
    render(<HomeHighScores />);
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /Top 10 high scores per game/i }),
      ).toBeInTheDocument();
    });
  });
});

describe('HomeHighScores – game labels', () => {
  beforeEach(() => {
    mockGetLeaderboard.mockResolvedValue([]);
  });

  it.each(GAME_LABELS)('shows "%s" game heading', async (label) => {
    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  });

  it('shows 8 game tabs', async () => {
    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(GAME_IDS.length);
    });
  });

  it('calls getLeaderboard once for the initially visible tab', async () => {
    render(<HomeHighScores />);
    await waitFor(() => {
      expect(mockGetLeaderboard).toHaveBeenCalledTimes(1);
    });
    expect(mockGetLeaderboard).toHaveBeenCalledWith('connectfive', 10);
  });
});

describe('HomeHighScores – offline mode', () => {
  it('skips leaderboard requests when the API is unavailable', async () => {
    mockIsAvailable.mockResolvedValue(false);

    render(<HomeHighScores />);

    await waitFor(() => {
      // Empty placeholder rows should appear (showing --- names)
      expect(screen.getAllByText('---').length).toBeGreaterThan(0);
    });

    expect(mockGetLeaderboard).not.toHaveBeenCalled();
  });
});

describe('HomeHighScores – empty leaderboards', () => {
  it('shows placeholder rows when API returns an empty array', async () => {
    mockGetLeaderboard.mockResolvedValue([]);
    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.getAllByText('---').length).toBeGreaterThan(0);
    });
  });

  it('shows placeholder rows when API returns null', async () => {
    mockGetLeaderboard.mockResolvedValue(null as unknown as PlayerStatsDto[]);
    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.getAllByText('---').length).toBeGreaterThan(0);
    });
  });
});

describe('HomeHighScores – leaderboard entries', () => {
  it('renders player names when leaderboard has entries', async () => {
    mockGetLeaderboard.mockImplementation(async (gameId) => {
      if (gameId === 'connectfive') return [makeEntry('Alice', 7, 10)];
      return [];
    });

    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
  });

  it('renders rank numbers (#1, #2 …) for multiple entries', async () => {
    mockGetLeaderboard.mockImplementation(async (gameId) => {
      if (gameId === 'tictactoe') {
        return [makeEntry('Bob', 8, 10), makeEntry('Carol', 6, 10)];
      }
      return [];
    });

    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
    });
  });

  it('displays win-rate, total-games and wins for an entry', async () => {
    // Dave: 15 wins / 20 games = 75% — put in connectfive (first/default tab)
    mockGetLeaderboard.mockImplementation(async (gameId) => {
      if (gameId === 'connectfive') return [makeEntry('Dave', 15, 20)];
      return [];
    });

    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.getByText('Dave')).toBeInTheDocument();
    });

    const row = screen.getByText('Dave').closest('li')!;
    expect(row.textContent).toContain('75%');
    expect(row.textContent).toContain('20G');
  });

  it('orders entries by rank (first entry shown first)', async () => {
    mockGetLeaderboard.mockImplementation(async (gameId) => {
      if (gameId === 'connectfive') {
        return [makeEntry('Top', 10, 10), makeEntry('Second', 8, 10)];
      }
      return [];
    });

    render(<HomeHighScores />);
    await waitFor(() => {
      const items = screen.getAllByRole('listitem');
      const topIdx = items.findIndex((el) => el.textContent?.includes('Top'));
      const secondIdx = items.findIndex((el) => el.textContent?.includes('Second'));
      expect(topIdx).toBeLessThan(secondIdx);
    });
  });

  it('shows entries for the active (default) tab', async () => {
    mockGetLeaderboard.mockImplementation(async (gameId) => {
      if (gameId === 'connectfive') return [makeEntry('CFPlayer', 5, 10)];
      return [];
    });

    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.getByText('CFPlayer')).toBeInTheDocument();
    });
  });
});
