import { Piece, Difficulty } from '../shared/types';
import { ConnectFiveBoard } from './ConnectFiveBoard';

/**
 * Connect Five AI with three difficulty levels.
 * - Easy: random valid column
 * - Medium: win → block → centre bias → random
 * - Hard: minimax with alpha-beta pruning (depth 5)
 */
export class ConnectFiveAI {
  static getMove(board: ConnectFiveBoard, player: Piece, difficulty: Difficulty): number {
    switch (difficulty) {
      case Difficulty.Easy:
        return ConnectFiveAI.easyMove(board);
      case Difficulty.Medium:
        return ConnectFiveAI.mediumMove(board, player);
      case Difficulty.Hard:
        return ConnectFiveAI.hardMove(board, player);
    }
  }

  // ─── Easy ──────────────────────────────────────────────────────
  private static easyMove(board: ConnectFiveBoard): number {
    const cols = board.getAvailableColumns();
    return cols[Math.floor(Math.random() * cols.length)]!;
  }

  // ─── Medium ────────────────────────────────────────────────────
  private static mediumMove(board: ConnectFiveBoard, player: Piece): number {
    const opponent = player === Piece.Red ? Piece.Yellow : Piece.Red;

    // 1. Win if possible
    const win = ConnectFiveAI.findWinningCol(board, player);
    if (win !== null) return win;

    // 2. Block opponent win
    const block = ConnectFiveAI.findWinningCol(board, opponent);
    if (block !== null) return block;

    // 3. Centre bias
    const mid = Math.floor(ConnectFiveBoard.Cols / 2);
    if (board.getTargetRow(mid) >= 0) return mid;

    // 4. Random
    return ConnectFiveAI.easyMove(board);
  }

  // ─── Hard (minimax) ───────────────────────────────────────────
  private static readonly MAX_DEPTH = 5;

  private static hardMove(board: ConnectFiveBoard, player: Piece): number {
    const opponent = player === Piece.Red ? Piece.Yellow : Piece.Red;
    let bestScore = -Infinity;
    let bestCol = board.getAvailableColumns()[0]!;

    // Evaluate columns from centre outward for better pruning
    const cols = ConnectFiveAI.centreOrdered(board.getAvailableColumns());

    for (const col of cols) {
      const next = board.drop(col, player);
      const score = ConnectFiveAI.minimax(next, ConnectFiveAI.MAX_DEPTH - 1, -Infinity, Infinity, false, player, opponent);
      if (score > bestScore) {
        bestScore = score;
        bestCol = col;
      }
    }
    return bestCol;
  }

  private static minimax(
    board: ConnectFiveBoard,
    depth: number,
    alpha: number,
    beta: number,
    isMaximising: boolean,
    player: Piece,
    opponent: Piece,
  ): number {
    if (board.checkWin(player).won) return 100000 + depth;
    if (board.checkWin(opponent).won) return -(100000 + depth);
    if (board.isFull() || depth === 0) return ConnectFiveAI.heuristic(board, player, opponent);

    const cols = ConnectFiveAI.centreOrdered(board.getAvailableColumns());

    if (isMaximising) {
      let best = -Infinity;
      for (const col of cols) {
        const next = board.drop(col, player);
        const score = ConnectFiveAI.minimax(next, depth - 1, alpha, beta, false, player, opponent);
        best = Math.max(best, score);
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
      return best;
    } else {
      let best = Infinity;
      for (const col of cols) {
        const next = board.drop(col, opponent);
        const score = ConnectFiveAI.minimax(next, depth - 1, alpha, beta, true, player, opponent);
        best = Math.min(best, score);
        beta = Math.min(beta, best);
        if (beta <= alpha) break;
      }
      return best;
    }
  }

  private static heuristic(board: ConnectFiveBoard, player: Piece, opponent: Piece): number {
    let score = 0;
    const R = ConnectFiveBoard.Rows;
    const C = ConnectFiveBoard.Cols;
    const W = ConnectFiveBoard.WinLength;
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]] as const;

    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        for (const [dr, dc] of directions) {
          let mine = 0;
          let theirs = 0;
          let empty = 0;
          let inBounds = true;
          for (let i = 0; i < W; i++) {
            const nr = r + dr * i;
            const nc = c + dc * i;
            if (nr < 0 || nr >= R || nc < 0 || nc >= C) { inBounds = false; break; }
            const cell = board.get(nr, nc);
            if (cell === player) mine++;
            else if (cell === opponent) theirs++;
            else empty++;
          }
          if (!inBounds) continue;
          if (theirs === 0 && mine > 0) score += ConnectFiveAI.windowScore(mine);
          if (mine === 0 && theirs > 0) score -= ConnectFiveAI.windowScore(theirs);
        }
      }
    }

    // Centre-column bonus
    const midCol = Math.floor(C / 2);
    for (let r = 0; r < R; r++) {
      if (board.get(r, midCol) === player) score += 3;
      if (board.get(r, midCol) === opponent) score -= 3;
    }

    return score;
  }

  private static windowScore(count: number): number {
    switch (count) {
      case 4: return 100;
      case 3: return 10;
      case 2: return 3;
      case 1: return 1;
      default: return 0;
    }
  }

  private static centreOrdered(cols: number[]): number[] {
    const mid = Math.floor(ConnectFiveBoard.Cols / 2);
    return [...cols].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  }

  private static findWinningCol(board: ConnectFiveBoard, player: Piece): number | null {
    for (const col of board.getAvailableColumns()) {
      const next = board.drop(col, player);
      if (next.checkWin(player).won) return col;
    }
    return null;
  }
}
