import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MultiPlayerSelectPage from '../../components/MultiPlayerSelectPage';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mockNavigate,
}));

describe('MultiPlayerSelectPage', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  it('shows local 2-player choices instead of the online lobby copy', () => {
    render(
      <MemoryRouter>
        <MultiPlayerSelectPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Choose a game for local 2-player couch play on this device.')).toBeInTheDocument();
  });

  it('opens Tic Tac Toe in local 2-player mode', () => {
    render(
      <MemoryRouter>
        <MultiPlayerSelectPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /play tic tac toe/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/tictactoe?local=1');
  });
});
