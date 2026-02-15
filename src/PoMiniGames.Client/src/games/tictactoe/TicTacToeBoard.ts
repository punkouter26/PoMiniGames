import { CellValue } from '../shared/types';

/** 6×6 Tic Tac Toe board with WinLength = 4. Immutable — every mutation returns a new board. */
export class TicTacToeBoard {
  static readonly Size = 6;
  static readonly WinLength = 4;

  private readonly cells: CellValue[][];

  constructor(cells?: CellValue[][]) {
    if (cells) {
      this.cells = cells;
    } else {
      this.cells = Array.from({ length: TicTacToeBoard.Size }, () =>
        Array.from({ length: TicTacToeBoard.Size }, () => CellValue.None),
      );
    }
  }

  /** Get cell value at (row, col). */
  get(row: number, col: number): CellValue {
    return this.cells[row]![col]!;
  }

  /** Return a new board with the piece placed at (row, col). */
  place(row: number, col: number, value: CellValue): TicTacToeBoard {
    if (this.cells[row]![col] !== CellValue.None) {
      throw new Error(`Cell (${row}, ${col}) is already occupied`);
    }
    const clone = this.cloneCells();
    clone[row]![col] = value;
    return new TicTacToeBoard(clone);
  }

  /** Check if the given player has won. Returns winning cells if so. */
  checkWin(player: CellValue): { won: boolean; cells: [number, number][] } {
    const S = TicTacToeBoard.Size;
    const W = TicTacToeBoard.WinLength;
    const directions = [
      [0, 1],   // horizontal
      [1, 0],   // vertical
      [1, 1],   // diagonal down
      [1, -1],  // diagonal up
    ] as const;

    for (let r = 0; r < S; r++) {
      for (let c = 0; c < S; c++) {
        for (const [dr, dc] of directions) {
          const line: [number, number][] = [];
          let valid = true;
          for (let i = 0; i < W; i++) {
            const nr = r + dr * i;
            const nc = c + dc * i;
            if (nr < 0 || nr >= S || nc < 0 || nc >= S || this.cells[nr]![nc] !== player) {
              valid = false;
              break;
            }
            line.push([nr, nc]);
          }
          if (valid) {
            return { won: true, cells: line };
          }
        }
      }
    }
    return { won: false, cells: [] };
  }

  /** True when every cell is occupied. */
  isFull(): boolean {
    for (let r = 0; r < TicTacToeBoard.Size; r++) {
      for (let c = 0; c < TicTacToeBoard.Size; c++) {
        if (this.cells[r]![c] === CellValue.None) return false;
      }
    }
    return true;
  }

  /** All empty cells as (row, col) tuples. */
  getAvailableMoves(): [number, number][] {
    const moves: [number, number][] = [];
    for (let r = 0; r < TicTacToeBoard.Size; r++) {
      for (let c = 0; c < TicTacToeBoard.Size; c++) {
        if (this.cells[r]![c] === CellValue.None) {
          moves.push([r, c]);
        }
      }
    }
    return moves;
  }

  private cloneCells(): CellValue[][] {
    return this.cells.map((row) => [...row]);
  }
}
