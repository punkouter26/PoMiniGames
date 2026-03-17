import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlayerNameProvider } from '../../context/PlayerNameContext';
import Home from '../../components/Home';

const { mockDevBypass, mockAuthState } = vi.hoisted(() => {
  const devBypass = vi.fn();
  return {
    mockDevBypass: devBypass,
    mockAuthState: {
      config: null as any,
      devBypass,
      isLoading: false,
    },
  };
});

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

// Stub out HomeHighScores to keep these tests focused on Home itself
vi.mock('../../components/HomeHighScores', () => ({
  default: () => (
    <section aria-label="Top 10 high scores per game" data-testid="mock-high-scores" />
  ),
}));

function renderHome(initialPath = '/') {
  return render(
    <PlayerNameProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Home />
      </MemoryRouter>
    </PlayerNameProvider>,
  );
}

const WORKFLOW_OPTIONS = [
  {
    label: 'Microsoft Login + Play 2 Players',
    href: '/lobby',
    ariaLabel: 'Microsoft login and play 2 players',
  },
  {
    label: 'Microsoft Login + Play 1 Player',
    href: '/single-player',
    ariaLabel: 'Microsoft login and play 1 player',
  },
  {
    label: 'DEMO MODE',
    href: '/demo',
    ariaLabel: 'Demo mode computer plays both players',
  },
];

describe('Home – page structure', () => {
  beforeEach(() => {
    localStorage.clear();
    mockAuthState.config = null;
    mockAuthState.isLoading = false;
    mockDevBypass.mockReset();
    mockDevBypass.mockResolvedValue(null);
  });

  it('renders the main PoMiniGames heading', () => {
    renderHome();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('PoMiniGames');
  });

  it('renders the "Choose how you want to play" subtitle', () => {
    renderHome();
    expect(screen.getByText(/Choose how you want to play/i)).toBeInTheDocument();
  });

  it('renders the player name label', () => {
    renderHome();
    expect(screen.getByText(/Player Name/i)).toBeInTheDocument();
  });

  it('renders a labelled player name input', () => {
    renderHome();
    const input = screen.getByLabelText(/Player name/i);
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
  });

  it('player name input defaults to "Player" when localStorage is empty', () => {
    renderHome();
    expect(screen.getByLabelText(/Player name/i)).toHaveValue('Player');
  });

  it('player name input reflects localStorage value', () => {
    localStorage.setItem('pomini_player', 'Gamer42');
    renderHome();
    expect(screen.getByLabelText(/Player name/i)).toHaveValue('Gamer42');
  });

  it('player name change updates localStorage', () => {
    renderHome();
    const input = screen.getByLabelText(/Player name/i);
    fireEvent.change(input, { target: { value: 'NewName' } });
    expect(localStorage.getItem('pomini_player')).toBe('NewName');
  });

  it('includes the high scores section', () => {
    renderHome();
    expect(screen.getByTestId('mock-high-scores')).toBeInTheDocument();
  });
});

describe('Home – workflow options', () => {
  beforeEach(() => {
    localStorage.clear();
    mockAuthState.config = null;
    mockAuthState.isLoading = false;
    mockDevBypass.mockReset();
    mockDevBypass.mockResolvedValue(null);
    renderHome();
  });

  it('renders exactly 3 mode cards', () => {
    for (const game of WORKFLOW_OPTIONS) {
      expect(screen.getByRole('heading', { name: game.label })).toBeInTheDocument();
    }
  });

  it('renders exactly 3 option links', () => {
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(WORKFLOW_OPTIONS.length);
  });

  it.each(WORKFLOW_OPTIONS)('$label card has correct href', ({ ariaLabel, href }) => {
    expect(screen.getByLabelText(ariaLabel)).toHaveAttribute('href', href);
  });

  it('renders expected action labels', () => {
    expect(screen.getByText(/Enter Lobby/i)).toBeInTheDocument();
    expect(screen.getByText(/Choose Game/i)).toBeInTheDocument();
    expect(screen.getByText(/Start Demo/i)).toBeInTheDocument();
  });

  it('demo mode card describes cpu-vs-cpu behavior', () => {
    expect(screen.getByText(/computer randomly picks a game/i)).toBeInTheDocument();
  });
});

describe('Home – developer bypass helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    mockDevBypass.mockReset();
    mockAuthState.isLoading = false;
    mockAuthState.config = {
      devLoginEnabled: true,
    };
    mockDevBypass.mockResolvedValue({ userId: 'dev-bypass-user', displayName: 'Dev Admin', email: 'devadmin@local.dev' });
    renderHome();
  });

  it('shows developer bypass buttons for 2P and 1P when dev login is enabled', () => {
    expect(screen.getByRole('button', { name: /Developer bypass for 2 player/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Developer bypass for 1 player/i })).toBeInTheDocument();
  });

  it('clicking bypass 2P triggers devBypass', () => {
    mockDevBypass.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: /Developer bypass for 2 player/i }));
    expect(mockDevBypass).toHaveBeenCalledTimes(1);
  });

  it('clicking bypass 1P triggers devBypass', () => {
    mockDevBypass.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: /Developer bypass for 1 player/i }));
    expect(mockDevBypass).toHaveBeenCalledTimes(1);
  });
});
