import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlayerNameProvider } from '../../context/PlayerNameContext';
import Home from '../../components/Home';

// Stub out HomeHighScores to keep these tests focused on Home itself
vi.mock('../../components/HomeHighScores', () => ({
  default: () => (
    <section aria-label="Top 10 high scores per game" data-testid="mock-high-scores" />
  ),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mockNavigate,
}));

function renderHome() {
  return render(
    <PlayerNameProvider>
      <MemoryRouter initialEntries={['/']}>
        <Home />
      </MemoryRouter>
    </PlayerNameProvider>,
  );
}

describe('Home – page structure', () => {
  beforeEach(() => {
    localStorage.clear();
    mockNavigate.mockReset();
  });

  it('renders the main PoMiniGames heading', () => {
    renderHome();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('PoMiniGames');
  });

  it('renders the "Choose how you want to play" subtitle', () => {
    renderHome();
    expect(screen.getByText(/Choose how you want to play/i)).toBeInTheDocument();
  });

  it('includes the high scores section', () => {
    renderHome();
    expect(screen.getByTestId('mock-high-scores')).toBeInTheDocument();
  });

  it('does not show a player name input (it lives in the nav bar)', () => {
    renderHome();
    expect(screen.queryByLabelText(/Player name/i)).not.toBeInTheDocument();
  });

  it('does not show developer bypass controls', () => {
    renderHome();
    expect(screen.queryByRole('button', { name: /bypass/i })).not.toBeInTheDocument();
  });
});

describe('Home – mode buttons', () => {
  beforeEach(() => {
    localStorage.clear();
    mockNavigate.mockReset();
  });

  it('renders exactly 3 mode buttons', () => {
    renderHome();
    expect(screen.getByLabelText(/Play 2 players/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Play 1 player/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Play demo mode/i)).toBeInTheDocument();
  });

  it('shows labels: 2 Players, 1 Player, Demo Mode', () => {
    renderHome();
    expect(screen.getByText('2 Players')).toBeInTheDocument();
    expect(screen.getByText('1 Player')).toBeInTheDocument();
    expect(screen.getByText('Demo Mode')).toBeInTheDocument();
  });

  it('clicking 2 Players navigates to /lobby', () => {
    renderHome();
    fireEvent.click(screen.getByLabelText(/Play 2 players/i));
    expect(mockNavigate).toHaveBeenCalledWith('/lobby');
  });

  it('clicking 1 Player navigates to /single-player', () => {
    renderHome();
    fireEvent.click(screen.getByLabelText(/Play 1 player/i));
    expect(mockNavigate).toHaveBeenCalledWith('/single-player');
  });

  it('clicking Demo Mode navigates to a demo route', () => {
    renderHome();
    fireEvent.click(screen.getByLabelText(/Play demo mode/i));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const route = mockNavigate.mock.calls[0]?.[0] as string;
    expect(route).toMatch(/demo=1/);
  });
});
