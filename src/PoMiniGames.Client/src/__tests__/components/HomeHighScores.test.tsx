import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { PlayerStatsDto } from '../../games/shared/types';
import HomeHighScores from '../../components/HomeHighScores';

// Mock the apiService so these tests never hit the network
vi.mock('../../games/shared/apiService', () => ({
  apiService: {
    getLeaderboard: vi.fn(),
  },
}));

// Import the mocked version so we can set return values per test
const { apiService } = await import('../../games/shared/apiService');
const mockGetLeaderboard = vi.mocked(apiService.getLeaderboard);

// Reset mocks between every test so call-count assertions stay isolated
beforeEach(() => {
  vi.clearAllMocks();
});

const GAME_IDS = [
  'connectfive',
  'tictactoe',
  'voxelshooter',
  'pofight',
  'podropsquare',
  'pobabytouch',
  'poraceragdoll',
] as const;

const GAME_LABELS = [
  'Connect Five',
  'Tic Tac Toe',
  'Voxel Shooter',
  'PoFight',
  'PoDropSquare',
  'PoBabyTouch',
  'PoRaceRagdoll',
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
      overallWinRate: rate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

describe('HomeHighScores – loading state', () => {
  it('shows "Loading high scores…" before data arrives', () => {
    // Never resolves so component stays in loading state
    mockGetLeaderboard.mockReturnValue(new Promise(() => {}));
    render(<HomeHighScores />);
    expect(screen.getByText(/Loading high scores/i)).toBeInTheDocument();
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

  it('shows exactly 7 game cards', async () => {
    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(GAME_IDS.length);
    });
  });

  it('calls getLeaderboard once for each of the 7 games', async () => {
    render(<HomeHighScores />);
    await waitFor(() => {
      expect(mockGetLeaderboard).toHaveBeenCalledTimes(GAME_IDS.length);
    });
    for (const id of GAME_IDS) {
      expect(mockGetLeaderboard).toHaveBeenCalledWith(id, 10);
    }
  });
});

describe('HomeHighScores – empty leaderboards', () => {
  it('shows "No entries yet." for every game when API returns empty arrays', async () => {
    mockGetLeaderboard.mockResolvedValue([]);
    render(<HomeHighScores />);
    await waitFor(() => {
      const noEntries = screen.getAllByText(/No entries yet\./i);
      expect(noEntries).toHaveLength(GAME_IDS.length);
    });
  });

  it('shows "No entries yet." when API returns null', async () => {
    mockGetLeaderboard.mockResolvedValue(null as unknown as PlayerStatsDto[]);
    render(<HomeHighScores />);
    await waitFor(() => {
      const noEntries = screen.getAllByText(/No entries yet\./i);
      expect(noEntries).toHaveLength(GAME_IDS.length);
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
    // Dave: 15 wins / 20 games = 75 %
    mockGetLeaderboard.mockImplementation(async (gameId) => {
      if (gameId === 'tictactoe') return [makeEntry('Dave', 15, 20)];
      return [];
    });

    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.getByText('Dave')).toBeInTheDocument();
    });

    const row = screen.getByText('Dave').closest('li')!;
    expect(row.textContent).toContain('75%');
    expect(row.textContent).toContain('20G');
    expect(row.textContent).toContain('15W');
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

  it('shows entries for multiple games simultaneously', async () => {
    mockGetLeaderboard.mockImplementation(async (gameId) => {
      if (gameId === 'connectfive') return [makeEntry('CFPlayer', 5, 10)];
      if (gameId === 'tictactoe') return [makeEntry('TTTPlayer', 3, 10)];
      return [];
    });

    render(<HomeHighScores />);
    await waitFor(() => {
      expect(screen.getByText('CFPlayer')).toBeInTheDocument();
      expect(screen.getByText('TTTPlayer')).toBeInTheDocument();
    });
  });
});
