import { CellValue, Difficulty } from '../shared/types';
import { TicTacToeBoard } from './TicTacToeBoard';

/**
 * Tic Tac Toe AI with three difficulty levels.
 * - Easy: random move, 30 % chance to block
 * - Medium: win → block → centre → random
 * - Hard: minimax with alpha-beta pruning (depth 4)
 */
export class TicTacToeAI {
  static getMove(board: TicTacToeBoard, player: CellValue, difficulty: Difficulty): [number, number] {
    switch (difficulty) {
      case Difficulty.Easy:
        return TicTacToeAI.easyMove(board, player);
      case Difficulty.Medium:
        return TicTacToeAI.mediumMove(board, player);
      case Difficulty.Hard:
        return TicTacToeAI.hardMove(board, player);
    }
  }

  // ─── Easy ──────────────────────────────────────────────────────
  private static easyMove(board: TicTacToeBoard, player: CellValue): [number, number] {
    const opponent = player === CellValue.X ? CellValue.O : CellValue.X;

    // 30 % chance to block an opponent win
    if (Math.random() < 0.3) {
      const block = TicTacToeAI.findWinningMove(board, opponent);
      if (block) return block;
    }

    const moves = board.getAvailableMoves();
    return moves[Math.floor(Math.random() * moves.length)]!;
  }

  // ─── Medium ────────────────────────────────────────────────────
  private static mediumMove(board: TicTacToeBoard, player: CellValue): [number, number] {
    const opponent = player === CellValue.X ? CellValue.O : CellValue.X;

    // 1. Win if possible
    const win = TicTacToeAI.findWinningMove(board, player);
    if (win) return win;

    // 2. Block opponent win
    const block = TicTacToeAI.findWinningMove(board, opponent);
    if (block) return block;

    // 3. Centre
    const mid = Math.floor(TicTacToeBoard.Size / 2);
    if (board.get(mid, mid) === CellValue.None) return [mid, mid];

    // 4. Random
    const moves = board.getAvailableMoves();
    return moves[Math.floor(Math.random() * moves.length)]!;
  }

  // ─── Hard (minimax) ───────────────────────────────────────────
  private static readonly MAX_DEPTH = 4;
  private static transpositionTable = new Map<string, number>();

  private static hardMove(board: TicTacToeBoard, player: CellValue): [number, number] {
    TicTacToeAI.transpositionTable.clear();
    const opponent = player === CellValue.X ? CellValue.O : CellValue.X;
    let bestScore = -Infinity;
    const bestMoves: [number, number][] = [];

    for (const [r, c] of board.getAvailableMoves()) {
      const next = board.place(r, c, player);
      const score = TicTacToeAI.minimax(next, TicTacToeAI.MAX_DEPTH - 1, -Infinity, Infinity, false, player, opponent);
      if (score > bestScore) {
        bestScore = score;
        bestMoves.length = 0; // Clear array
        bestMoves.push([r, c]);
      } else if (score === bestScore) {
        bestMoves.push([r, c]); // Track equally good moves
      }
    }
    
    // Randomly choose among equally good moves to avoid predictability
    return bestMoves[Math.floor(Math.random() * bestMoves.length)]!;
  }

  private static minimax(
    board: TicTacToeBoard,
    depth: number,
    alpha: number,
    beta: number,
    isMaximising: boolean,
    player: CellValue,
    opponent: CellValue,
  ): number {
    // Terminal checks
    if (board.checkWin(player).won) return 1000 + depth;
    if (board.checkWin(opponent).won) return -(1000 + depth);
    if (board.isFull() || depth === 0) return TicTacToeAI.heuristic(board, player, opponent);

    const key = TicTacToeAI.boardKey(board, isMaximising);
    const cached = TicTacToeAI.transpositionTable.get(key);
    if (cached !== undefined) return cached;

    let best: number;
    if (isMaximising) {
      best = -Infinity;
      for (const [r, c] of board.getAvailableMoves()) {
        const next = board.place(r, c, player);
        const score = TicTacToeAI.minimax(next, depth - 1, alpha, beta, false, player, opponent);
        best = Math.max(best, score);
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
    } else {
      best = Infinity;
      for (const [r, c] of board.getAvailableMoves()) {
        const next = board.place(r, c, opponent);
        const score = TicTacToeAI.minimax(next, depth - 1, alpha, beta, true, player, opponent);
        best = Math.min(best, score);
        beta = Math.min(beta, best);
        if (beta <= alpha) break;
      }
    }

    TicTacToeAI.transpositionTable.set(key, best);
    return best;
  }

  private static heuristic(board: TicTacToeBoard, player: CellValue, opponent: CellValue): number {
    let score = 0;
    const S = TicTacToeBoard.Size;
    const W = TicTacToeBoard.WinLength;
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]] as const;

    for (let r = 0; r < S; r++) {
      for (let c = 0; c < S; c++) {
        for (const [dr, dc] of directions) {
          let mine = 0;
          let theirs = 0;
          let valid = true;
          for (let i = 0; i < W; i++) {
            const nr = r + dr * i;
            const nc = c + dc * i;
            if (nr < 0 || nr >= S || nc < 0 || nc >= S) { valid = false; break; }
            const cell = board.get(nr, nc);
            if (cell === player) mine++;
            else if (cell === opponent) theirs++;
          }
          if (!valid) continue;
          if (theirs === 0 && mine > 0) score += mine * mine;
          if (mine === 0 && theirs > 0) score -= theirs * theirs;
        }
      }
    }
    return score;
  }

  private static boardKey(board: TicTacToeBoard, isMax: boolean): string {
    let key = isMax ? '1' : '0';
    for (let r = 0; r < TicTacToeBoard.Size; r++) {
      for (let c = 0; c < TicTacToeBoard.Size; c++) {
        key += board.get(r, c).toString();
      }
    }
    return key;
  }

  // ─── Helpers ──────────────────────────────────────────────────
  private static findWinningMove(board: TicTacToeBoard, player: CellValue): [number, number] | null {
    for (const [r, c] of board.getAvailableMoves()) {
      const next = board.place(r, c, player);
      if (next.checkWin(player).won) return [r, c];
    }
    return null;
  }
}
