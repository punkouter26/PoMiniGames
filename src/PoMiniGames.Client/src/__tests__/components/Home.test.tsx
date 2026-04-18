import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlayerNameProvider } from '../../context/PlayerNameContext';
import Home from '../../components/Home';

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

  it('shows the three main home choices', () => {
    renderHome();
    expect(screen.getByText('2 Players')).toBeInTheDocument();
    expect(screen.getByText('1 Player')).toBeInTheDocument();
    expect(screen.getByText('Demo')).toBeInTheDocument();
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
    expect(screen.getByLabelText(/Watch demo mode/i)).toBeInTheDocument();
  });

  it('shows labels: 2 Players, 1 Player, Demo', () => {
    renderHome();
    expect(screen.getByText('2 Players')).toBeInTheDocument();
    expect(screen.getByText('1 Player')).toBeInTheDocument();
    expect(screen.getByText('Demo')).toBeInTheDocument();
  });

  it('clicking 2 Players navigates to the local 2-player picker', () => {
    renderHome();
    fireEvent.click(screen.getByLabelText(/Play 2 players/i));
    expect(mockNavigate).toHaveBeenCalledWith('/multi-player-select');
  });

  it('clicking 1 Player navigates to /single-player', () => {
    renderHome();
    fireEvent.click(screen.getByLabelText(/Play 1 player/i));
    expect(mockNavigate).toHaveBeenCalledWith('/single-player');
  });

  it('clicking Demo opens the demo flow', () => {
    renderHome();
    fireEvent.click(screen.getByLabelText(/Watch demo mode/i));
    expect(mockNavigate).toHaveBeenCalled();
  });
});
