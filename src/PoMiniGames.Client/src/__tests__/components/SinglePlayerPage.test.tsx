import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SinglePlayerPage from '../../components/SinglePlayerPage';

const { mockAuthState } = vi.hoisted(() => ({
  mockAuthState: {
    isLoading: false,
  },
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <SinglePlayerPage />
    </MemoryRouter>,
  );
}

describe('SinglePlayerPage', () => {
  beforeEach(() => {
    mockAuthState.isLoading = false;
  });

  it('shows skeleton cards while the page is loading', () => {
    mockAuthState.isLoading = true;
    const { container } = renderPage();

    expect(container.querySelectorAll('.sp-skeleton-card')).toHaveLength(6);
  });

  it('renders the current single-player heading and mode buttons', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: /Pick a Single-Player Game/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Play games/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Watch demos/i })).toBeInTheDocument();
  });

  it('shows all single-player games', () => {
    renderPage();

    const expectedAriaLabels = [
      'Play Connect Five single player',
      'Play Tic Tac Toe single player',
      'Play Voxel Shooter single player',
      'Play PoFight single player',
      'Play PoDropSquare single player',
      'Play PoBabyTouch single player',
      'Play PoRaceRagdoll single player',
      'Play PoSnakeGame single player',
      'Play PoHorseRace single player',
    ] as const;

    for (const ariaLabel of expectedAriaLabels) {
      expect(screen.getByLabelText(ariaLabel)).toBeInTheDocument();
    }
  });

  it('only advertises 2P for games that support local two-player mode', () => {
    renderPage();

    expect(screen.getByLabelText('Play Connect Five single player')).toHaveTextContent('2P');
    expect(screen.getByLabelText('Play Tic Tac Toe single player')).toHaveTextContent('2P');
    expect(screen.getByLabelText('Play PoFight single player')).not.toHaveTextContent('2P');
    expect(screen.getByLabelText('Play PoSnakeGame single player')).not.toHaveTextContent('2P');
  });
});
