import { describe, it, expect } from 'vitest';
import { CellValue } from '../../games/shared/types';
import { TicTacToeBoard } from '../../games/tictactoe/TicTacToeBoard';

describe('TicTacToeBoard', () => {
  it('new board has all cells empty', () => {
    const board = new TicTacToeBoard();
    for (let r = 0; r < TicTacToeBoard.Size; r++) {
      for (let c = 0; c < TicTacToeBoard.Size; c++) {
        expect(board.get(r, c)).toBe(CellValue.None);
      }
    }
  });

  it('place returns new board with piece at position', () => {
    const board = new TicTacToeBoard();
    const next = board.place(2, 3, CellValue.X);
    expect(next.get(2, 3)).toBe(CellValue.X);
    expect(board.get(2, 3)).toBe(CellValue.None); // original immutable
  });

  it('place throws when cell occupied', () => {
    const board = new TicTacToeBoard().place(0, 0, CellValue.X);
    expect(() => board.place(0, 0, CellValue.O)).toThrow();
  });

  it('checkWin detects horizontal', () => {
    const board = new TicTacToeBoard()
      .place(0, 0, CellValue.X)
      .place(0, 1, CellValue.X)
      .place(0, 2, CellValue.X)
      .place(0, 3, CellValue.X);

    const { won, cells } = board.checkWin(CellValue.X);
    expect(won).toBe(true);
    expect(cells).toHaveLength(TicTacToeBoard.WinLength);
  });

  it('checkWin detects vertical', () => {
    const board = new TicTacToeBoard()
      .place(1, 2, CellValue.O)
      .place(2, 2, CellValue.O)
      .place(3, 2, CellValue.O)
      .place(4, 2, CellValue.O);

    expect(board.checkWin(CellValue.O).won).toBe(true);
  });

  it('checkWin detects diagonal down', () => {
    const board = new TicTacToeBoard()
      .place(0, 0, CellValue.X)
      .place(1, 1, CellValue.X)
      .place(2, 2, CellValue.X)
      .place(3, 3, CellValue.X);

    expect(board.checkWin(CellValue.X).won).toBe(true);
  });

  it('checkWin detects diagonal up', () => {
    const board = new TicTacToeBoard()
      .place(3, 0, CellValue.X)
      .place(2, 1, CellValue.X)
      .place(1, 2, CellValue.X)
      .place(0, 3, CellValue.X);

    expect(board.checkWin(CellValue.X).won).toBe(true);
  });

  it('three in a row does not win', () => {
    const board = new TicTacToeBoard()
      .place(0, 0, CellValue.X)
      .place(0, 1, CellValue.X)
      .place(0, 2, CellValue.X);

    expect(board.checkWin(CellValue.X).won).toBe(false);
  });

  it('isFull returns false on new board', () => {
    expect(new TicTacToeBoard().isFull()).toBe(false);
  });

  it('getAvailableMoves returns all cells on new board', () => {
    const moves = new TicTacToeBoard().getAvailableMoves();
    expect(moves).toHaveLength(TicTacToeBoard.Size * TicTacToeBoard.Size);
  });

  it('getAvailableMoves excludes occupied cells', () => {
    const board = new TicTacToeBoard().place(0, 0, CellValue.X);
    const moves = board.getAvailableMoves();
    expect(moves.some(([r, c]) => r === 0 && c === 0)).toBe(false);
  });
});
