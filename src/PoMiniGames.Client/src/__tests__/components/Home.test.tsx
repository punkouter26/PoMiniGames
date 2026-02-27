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

function renderHome(initialPath = '/') {
  return render(
    <PlayerNameProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Home />
      </MemoryRouter>
    </PlayerNameProvider>,
  );
}

const ALL_GAMES = [
  { label: 'Connect Five', href: '/connectfive', ariaLabel: 'Play Connect Five' },
  { label: 'Tic Tac Toe', href: '/tictactoe', ariaLabel: 'Play Tic Tac Toe' },
  { label: 'Voxel Shooter', href: '/voxelshooter', ariaLabel: 'Play Voxel Shooter' },
  { label: 'PoFight', href: '/pofight', ariaLabel: 'Play PoFight' },
  { label: 'PoDropSquare', href: '/podropsquare', ariaLabel: 'Play PoDropSquare' },
  { label: 'PoBabyTouch', href: '/pobabytouch', ariaLabel: 'Play PoBabyTouch' },
  { label: 'PoRaceRagdoll', href: '/poraceragdoll', ariaLabel: 'Play PoRaceRagdoll' },
];

describe('Home – page structure', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the main PoMiniGames heading', () => {
    renderHome();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('PoMiniGames');
  });

  it('renders the "Choose a game to play" subtitle', () => {
    renderHome();
    expect(screen.getByText(/Choose a game to play/i)).toBeInTheDocument();
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

describe('Home – game cards', () => {
  beforeEach(() => {
    localStorage.clear();
    renderHome();
  });

  it('renders all 7 game cards', () => {
    for (const game of ALL_GAMES) {
      expect(screen.getByRole('heading', { name: game.label })).toBeInTheDocument();
    }
  });

  it('renders exactly 7 game card links', () => {
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(ALL_GAMES.length);
  });

  it.each(ALL_GAMES)('$label card has correct href', ({ ariaLabel, href }) => {
    expect(screen.getByLabelText(ariaLabel)).toHaveAttribute('href', href);
  });

  it('each game card has a Play button text', () => {
    const playButtons = screen.getAllByText(/Play/);
    expect(playButtons.length).toBeGreaterThanOrEqual(ALL_GAMES.length);
  });

  it('Connect Five card describes the game', () => {
    expect(screen.getByText(/9×9 board/i)).toBeInTheDocument();
  });

  it('Tic Tac Toe card describes the game', () => {
    expect(screen.getByText(/6×6 board/i)).toBeInTheDocument();
  });
});
