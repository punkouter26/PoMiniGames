import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SinglePlayerPage from '../../components/SinglePlayerPage';

const { mockSignIn, mockAuthState } = vi.hoisted(() => {
  const signIn = vi.fn();
  return {
    mockSignIn: signIn,
    mockAuthState: {
      config: { microsoftEnabled: true },
      isAuthenticated: false,
      isConfigured: true,
      isLoading: false,
      signIn,
    },
  };
});

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
    mockSignIn.mockReset();
    mockAuthState.config = { microsoftEnabled: true };
    mockAuthState.isAuthenticated = false;
    mockAuthState.isConfigured = true;
    mockAuthState.isLoading = false;
    mockAuthState.signIn = mockSignIn;
  });

  it('shows unavailable state when auth is not configured', () => {
    mockAuthState.isConfigured = false;

    renderPage();

    expect(screen.getByRole('heading', { name: /Single Player/i })).toBeInTheDocument();
    expect(screen.getByText(/sign-in is not available/i)).toBeInTheDocument();
  });

  it('shows loading state while auth is loading', () => {
    mockAuthState.isLoading = true;

    renderPage();

    expect(screen.getByText(/Loading.../i)).toBeInTheDocument();
  });

  it('shows sign-in gate when user is not authenticated', () => {
    mockAuthState.isAuthenticated = false;

    renderPage();

    expect(screen.getByRole('heading', { name: /Single Player/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in with Microsoft/i })).toBeInTheDocument();
  });

  it('shows all single-player games when authenticated', () => {
    mockAuthState.isAuthenticated = true;

    renderPage();

    const expectedGames = [
      ['Play Connect Five single player', '/connectfive'],
      ['Play Tic Tac Toe single player', '/tictactoe'],
      ['Play Voxel Shooter single player', '/voxelshooter'],
      ['Play PoFight single player', '/pofight'],
      ['Play PoDropSquare single player', '/podropsquare'],
      ['Play PoBabyTouch single player', '/pobabytouch'],
      ['Play PoRaceRagdoll single player', '/poraceragdoll'],
      ['Play PoSnakeGame single player', '/posnakegame'],
    ] as const;

    for (const [ariaLabel, href] of expectedGames) {
      expect(screen.getByLabelText(ariaLabel)).toHaveAttribute('href', href);
    }

    expect(screen.getAllByRole('link')).toHaveLength(expectedGames.length);
  });
});
