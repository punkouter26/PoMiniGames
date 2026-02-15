import { describe, it, expect } from 'vitest';
import { Piece } from '../../games/shared/types';
import { ConnectFiveBoard } from '../../games/connectfive/ConnectFiveBoard';

describe('ConnectFiveBoard', () => {
  it('new board has all cells empty', () => {
    const board = new ConnectFiveBoard();
    for (let r = 0; r < ConnectFiveBoard.Rows; r++) {
      for (let c = 0; c < ConnectFiveBoard.Cols; c++) {
        expect(board.get(r, c)).toBe(Piece.None);
      }
    }
  });

  it('drop places piece at bottom', () => {
    const board = new ConnectFiveBoard().drop(4, Piece.Red);
    expect(board.get(ConnectFiveBoard.Rows - 1, 4)).toBe(Piece.Red);
  });

  it('drop stacks pieces', () => {
    const board = new ConnectFiveBoard()
      .drop(3, Piece.Red)
      .drop(3, Piece.Yellow);

    expect(board.get(ConnectFiveBoard.Rows - 1, 3)).toBe(Piece.Red);
    expect(board.get(ConnectFiveBoard.Rows - 2, 3)).toBe(Piece.Yellow);
  });

  it('drop is immutable', () => {
    const original = new ConnectFiveBoard();
    const next = original.drop(0, Piece.Red);
    expect(original.get(ConnectFiveBoard.Rows - 1, 0)).toBe(Piece.None);
    expect(next.get(ConnectFiveBoard.Rows - 1, 0)).toBe(Piece.Red);
  });

  it('drop throws when column full', () => {
    let board = new ConnectFiveBoard();
    for (let i = 0; i < ConnectFiveBoard.Rows; i++) {
      board = board.drop(0, i % 2 === 0 ? Piece.Red : Piece.Yellow);
    }
    expect(() => board.drop(0, Piece.Red)).toThrow();
  });

  it('checkWin detects horizontal', () => {
    let board = new ConnectFiveBoard();
    for (let c = 0; c < ConnectFiveBoard.WinLength; c++) {
      board = board.drop(c, Piece.Red);
    }
    const { won, cells } = board.checkWin(Piece.Red);
    expect(won).toBe(true);
    expect(cells).toHaveLength(ConnectFiveBoard.WinLength);
  });

  it('checkWin detects vertical', () => {
    let board = new ConnectFiveBoard();
    for (let i = 0; i < ConnectFiveBoard.WinLength; i++) {
      board = board.drop(2, Piece.Yellow);
    }
    expect(board.checkWin(Piece.Yellow).won).toBe(true);
  });

  it('checkWin detects diagonal down', () => {
    let board = new ConnectFiveBoard();

    // Col 0: 1 Red
    board = board.drop(0, Piece.Red);
    // Col 1: 1 Yellow filler, then Red
    board = board.drop(1, Piece.Yellow);
    board = board.drop(1, Piece.Red);
    // Col 2: 2 Yellow fillers, then Red
    board = board.drop(2, Piece.Yellow);
    board = board.drop(2, Piece.Yellow);
    board = board.drop(2, Piece.Red);
    // Col 3: 3 Yellow fillers, then Red
    board = board.drop(3, Piece.Yellow);
    board = board.drop(3, Piece.Yellow);
    board = board.drop(3, Piece.Yellow);
    board = board.drop(3, Piece.Red);
    // Col 4: 4 Yellow fillers, then Red
    board = board.drop(4, Piece.Yellow);
    board = board.drop(4, Piece.Yellow);
    board = board.drop(4, Piece.Yellow);
    board = board.drop(4, Piece.Yellow);
    board = board.drop(4, Piece.Red);

    expect(board.checkWin(Piece.Red).won).toBe(true);
  });

  it('four in a row does not win', () => {
    let board = new ConnectFiveBoard();
    for (let c = 0; c < 4; c++) {
      board = board.drop(c, Piece.Red);
    }
    expect(board.checkWin(Piece.Red).won).toBe(false);
  });

  it('getAvailableColumns returns all on new board', () => {
    expect(new ConnectFiveBoard().getAvailableColumns()).toHaveLength(ConnectFiveBoard.Cols);
  });

  it('getAvailableColumns excludes full column', () => {
    let board = new ConnectFiveBoard();
    for (let i = 0; i < ConnectFiveBoard.Rows; i++) {
      board = board.drop(0, Piece.Red);
    }
    expect(board.getAvailableColumns()).not.toContain(0);
  });

  it('getTargetRow returns bottom on empty column', () => {
    expect(new ConnectFiveBoard().getTargetRow(5)).toBe(ConnectFiveBoard.Rows - 1);
  });

  it('getTargetRow returns -1 on full column', () => {
    let board = new ConnectFiveBoard();
    for (let i = 0; i < ConnectFiveBoard.Rows; i++) {
      board = board.drop(0, Piece.Red);
    }
    expect(board.getTargetRow(0)).toBe(-1);
  });
});
