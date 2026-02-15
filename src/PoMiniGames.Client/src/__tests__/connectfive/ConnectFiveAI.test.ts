import { describe, it, expect } from 'vitest';
import { Piece, Difficulty } from '../../games/shared/types';
import { ConnectFiveBoard } from '../../games/connectfive/ConnectFiveBoard';
import { ConnectFiveAI } from '../../games/connectfive/ConnectFiveAI';

describe('ConnectFiveAI', () => {
  it.each([Difficulty.Easy, Difficulty.Medium, Difficulty.Hard])(
    'getMove returns a valid column (%s)',
    (difficulty) => {
      const board = new ConnectFiveBoard();
      const col = ConnectFiveAI.getMove(board, Piece.Yellow, difficulty);

      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(ConnectFiveBoard.Cols);
      expect(board.getTargetRow(col)).toBeGreaterThanOrEqual(0);
    },
  );

  it.each([Difficulty.Medium, Difficulty.Hard])(
    'takes winning move (%s)',
    (difficulty) => {
      // Yellow has 4 in bottom row (cols 0-3), should drop at col 4
      let board = new ConnectFiveBoard();
      for (let c = 0; c < 4; c++) {
        board = board.drop(c, Piece.Yellow);
      }
      const col = ConnectFiveAI.getMove(board, Piece.Yellow, difficulty);
      expect(col).toBe(4);
    },
  );

  it.each([Difficulty.Medium, Difficulty.Hard])(
    'blocks opponent win (%s)',
    (difficulty) => {
      // Red has 4 in bottom row (cols 0-3), AI (Yellow) should block at col 4
      let board = new ConnectFiveBoard();
      for (let c = 0; c < 4; c++) {
        board = board.drop(c, Piece.Red);
      }
      const col = ConnectFiveAI.getMove(board, Piece.Yellow, difficulty);
      expect(col).toBe(4);
    },
  );
});
