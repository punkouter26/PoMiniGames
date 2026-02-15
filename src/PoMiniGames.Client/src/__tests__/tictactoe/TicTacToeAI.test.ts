import { describe, it, expect } from 'vitest';
import { CellValue, Difficulty } from '../../games/shared/types';
import { TicTacToeBoard } from '../../games/tictactoe/TicTacToeBoard';
import { TicTacToeAI } from '../../games/tictactoe/TicTacToeAI';

describe('TicTacToeAI', () => {
  it.each([Difficulty.Easy, Difficulty.Medium, Difficulty.Hard])(
    'getMove returns a valid move (%s)',
    (difficulty) => {
      const board = new TicTacToeBoard();
      const [row, col] = TicTacToeAI.getMove(board, CellValue.O, difficulty);

      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(TicTacToeBoard.Size);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(TicTacToeBoard.Size);
      expect(board.get(row, col)).toBe(CellValue.None);
    },
  );

  it.each([Difficulty.Medium, Difficulty.Hard])(
    'blocks opponent win (%s)',
    (difficulty) => {
      // O O O _ — col 3 would complete a win for O
      const board = new TicTacToeBoard()
        .place(0, 0, CellValue.O)
        .place(0, 1, CellValue.O)
        .place(0, 2, CellValue.O);

      const [row, col] = TicTacToeAI.getMove(board, CellValue.X, difficulty);
      expect(row).toBe(0);
      expect(col).toBe(3);
    },
  );

  it.each([Difficulty.Medium, Difficulty.Hard])(
    'takes winning move (%s)',
    (difficulty) => {
      // X has 3 in a row at row 2, cols 0-2 — should complete at col 3
      const board = new TicTacToeBoard()
        .place(2, 0, CellValue.X)
        .place(2, 1, CellValue.X)
        .place(2, 2, CellValue.X);

      const [row, col] = TicTacToeAI.getMove(board, CellValue.X, difficulty);
      expect(row).toBe(2);
      expect(col).toBe(3);
    },
  );
});
