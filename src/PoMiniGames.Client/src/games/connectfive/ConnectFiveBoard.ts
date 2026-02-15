import { Piece } from '../shared/types';

/** 9×9 Connect Five board with gravity-based drops. Immutable. */
export class ConnectFiveBoard {
  static readonly Rows = 9;
  static readonly Cols = 9;
  static readonly WinLength = 5;

  private readonly cells: Piece[][];

  constructor(cells?: Piece[][]) {
    if (cells) {
      this.cells = cells;
    } else {
      this.cells = Array.from({ length: ConnectFiveBoard.Rows }, () =>
        Array.from({ length: ConnectFiveBoard.Cols }, () => Piece.None),
      );
    }
  }

  /** Get piece at (row, col). */
  get(row: number, col: number): Piece {
    return this.cells[row]![col]!;
  }

  /** Return the target row for a drop in the given column (-1 if full). */
  getTargetRow(col: number): number {
    for (let r = ConnectFiveBoard.Rows - 1; r >= 0; r--) {
      if (this.cells[r]![col] === Piece.None) return r;
    }
    return -1;
  }

  /** Drop a piece into a column with gravity. Returns a new board. */
  drop(col: number, piece: Piece): ConnectFiveBoard {
    const row = this.getTargetRow(col);
    if (row < 0) throw new Error(`Column ${col} is full`);
    const clone = this.cloneCells();
    clone[row]![col] = piece;
    return new ConnectFiveBoard(clone);
  }

  /** Check if the given player has won. */
  checkWin(player: Piece): { won: boolean; cells: [number, number][] } {
    const R = ConnectFiveBoard.Rows;
    const C = ConnectFiveBoard.Cols;
    const W = ConnectFiveBoard.WinLength;
    const directions = [
      [0, 1],   // horizontal
      [1, 0],   // vertical
      [1, 1],   // diagonal down
      [1, -1],  // diagonal up
    ] as const;

    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        for (const [dr, dc] of directions) {
          const line: [number, number][] = [];
          let valid = true;
          for (let i = 0; i < W; i++) {
            const nr = r + dr * i;
            const nc = c + dc * i;
            if (nr < 0 || nr >= R || nc < 0 || nc >= C || this.cells[nr]![nc] !== player) {
              valid = false;
              break;
            }
            line.push([nr, nc]);
          }
          if (valid) return { won: true, cells: line };
        }
      }
    }
    return { won: false, cells: [] };
  }

  /** True when every cell is occupied. */
  isFull(): boolean {
    for (let c = 0; c < ConnectFiveBoard.Cols; c++) {
      if (this.cells[0]![c] === Piece.None) return false;
    }
    return true;
  }

  /** Columns that still have at least one empty cell. */
  getAvailableColumns(): number[] {
    const cols: number[] = [];
    for (let c = 0; c < ConnectFiveBoard.Cols; c++) {
      if (this.getTargetRow(c) >= 0) cols.push(c);
    }
    return cols;
  }

  private cloneCells(): Piece[][] {
    return this.cells.map((row) => [...row]);
  }
}
