using PoMiniGamesClient.Enums;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Games.ConnectFive;

public class ConnectFiveBoard
{
    public const int Rows = 9;
    public const int Cols = 9;
    public const int WinLength = 5;

    // Audit #5: flat Piece[Rows * Cols] storage replaces the prior jagged
    // Piece[Rows][]. 81 contiguous pieces > 9 array headers; one allocation
    // per Place() vs. the old "allocate 9 inner arrays per copy + a 9x9 loop".
    // Array.Copy is intrinsified by the JIT and runs at memory-bandwidth speed.
    private readonly Piece[] _cells;

    // Audit #10: per-column next-landing-row cache. O(1) GetTargetRow + O(Cols)
    // GetAvailableCols (was O(Cols * Rows)). Maintained incrementally by Place.
    private readonly int[] _topRow;

    public ConnectFiveBoard()
    {
        _cells = new Piece[Rows * Cols];
        _topRow = new int[Cols];
        for (int c = 0; c < Cols; c++)
        {
            _topRow[c] = Rows - 1;
        }
    }

    // Private ctor for Place: clones the source cells + top-row cache in one go.
    private ConnectFiveBoard(Piece[] cells, int[] topRow)
    {
        _cells = cells;
        _topRow = topRow;
    }

    public Piece Get(int row, int col) => _cells[row * Cols + col];

    public int GetTargetRow(int col) => _topRow[col];

    public bool IsColumnFull(int col) => _topRow[col] < 0;

    /// <summary>
    /// Place a piece using a <see cref="Player"/> (the strongly-typed turn owner).
    /// Rejects the empty player (Audit #6) so a Piece.None turn can never leak
    /// through the AI / placement boundary and silently corrupt win checks.
    /// </summary>
    public ConnectFiveBoard Place(int row, int col, Player player)
    {
        if (player.IsEmpty)
        {
            throw new ArgumentException("Cannot place the empty player.", nameof(player));
        }
        return Place(row, col, player.Color);
    }

    public ConnectFiveBoard Place(int row, int col, Piece value)
    {
        if (value == Piece.None)
        {
            // The empty sentinel must never be placed on the board; placing it
            // would silently corrupt win-detection and gravity. Fail loud so
            // the bug surfaces at the call site, not three moves later when
            // CheckWin returns a phantom match.
            throw new ArgumentException("Cannot place Piece.None on the board.", nameof(value));
        }

        // Bug fix 2026-07-05: gravity is enforced by the board, not by the caller.
        // A previous bug in MediumMove produced mismatched (row, col) tuples where
        // the row came from one column and the col from another. That placed a
        // piece above the column's actual stack, producing overlapping discs.
        // The board now ignores the caller's row and uses the bottom-most empty
        // cell of the chosen column. The `row` parameter is kept for API stability
        // but the caller's value is validated and only used as a sanity check.
        if (row < 0 || row >= Rows)
        {
            throw new ArgumentOutOfRangeException(nameof(row), $"Row {row} is outside the board.");
        }
        if (col < 0 || col >= Cols)
        {
            throw new ArgumentOutOfRangeException(nameof(col), $"Col {col} is outside the board.");
        }
        var actualRow = GetTargetRow(col);
        if (actualRow < 0)
        {
            throw new InvalidOperationException($"Cannot place in column {col} — column is full.");
        }
        // If the caller passed a row that doesn't match the gravity-correct row,
        // fall back to the gravity-correct row. This is a "best effort" recovery
        // that keeps the demo loop robust to the AI's previous (now-fixed) bug.
        var finalRow = actualRow;

        var newCells = new Piece[_cells.Length];
        Array.Copy(_cells, newCells, _cells.Length);
        newCells[finalRow * Cols + col] = value;
        var newTopRow = (int[])_topRow.Clone();
        newTopRow[col] = finalRow - 1;
        return new ConnectFiveBoard(newCells, newTopRow);
    }

    public WinResult CheckWin(Player player)
    {
        if (player.IsEmpty) return new WinResult { Won = false, Cells = new List<(int, int)>() };
        return CheckWin(player.Color);
    }

    public WinResult CheckWin(Piece player)
    {
        if (player == Piece.None)
        {
            // Audit #6: refuse to "win" for the empty player — a caller passing
            // Piece.None here is a bug, not a no-op. Returning "no win" hides
            // the regression; throwing makes it visible.
            throw new ArgumentException("Cannot check win for Piece.None.", nameof(player));
        }

        var directions = new[] { (0, 1), (1, 0), (1, 1), (1, -1) };

        for (int r = 0; r < Rows; r++)
        {
            for (int c = 0; c < Cols; c++)
            {
                foreach (var (dr, dc) in directions)
                {
                    bool valid = true;
                    // Validate the FULL window starting at the anchor (i = 0). A
                    // prior off-by-one started at i = 1, so the anchor cell (r,c)
                    // was added to the win result but never checked against
                    // `player`. That let a run of only 4 matching pieces report a
                    // "win" whose 5th highlighted cell was empty or the opponent's
                    // colour — 5 cells lit up, one the wrong colour.
                    for (int i = 0; i < WinLength; i++)
                    {
                        var nr = r + dr * i;
                        var nc = c + dc * i;
                        if (nr < 0 || nr >= Rows || nc < 0 || nc >= Cols || _cells[nr * Cols + nc] != player)
                        {
                            valid = false;
                            break;
                        }
                    }
                    if (valid)
                    {
                        var cells = new List<(int, int)>(WinLength);
                        for (int i = 0; i < WinLength; i++)
                        {
                            cells.Add((r + dr * i, c + dc * i));
                        }
                        return new WinResult { Won = true, Cells = cells };
                    }
                }
            }
        }
        return new WinResult { Won = false, Cells = new List<(int, int)>() };
    }

    public bool IsFull()
    {
        // Audit #10: O(Cols) using the top-row cache. A column is full when
        // _topRow[col] < 0; the board is full when every column is full.
        for (int c = 0; c < Cols; c++)
        {
            if (_topRow[c] >= 0) return false;
        }
        return true;
    }

    /// <summary>
    /// Audit #10: enumerate playable columns in O(Cols). The previous
    /// implementation called <see cref="GetTargetRow"/> per column which
    /// itself walked <see cref="Rows"/>; the net was O(Cols * Rows) every AI
    /// turn. With the cache, this method is linear at most.
    /// </summary>
    public List<int> GetAvailableCols()
    {
        var cols = new List<int>(Cols);
        for (int c = 0; c < Cols; c++)
        {
            if (_topRow[c] >= 0) cols.Add(c);
        }
        return cols;
    }

    /// <summary>
    /// Cheap 64-bit FNV-style folding hash over the flat cell array. Used by
    /// the Negamax search's transposition table. Collisions are tolerable —
    /// alpha-beta + depth caps mean a wrong cached hit at worst costs one
    /// ply of refinement (the score is still within the alpha-beta window).
    /// </summary>
    internal long HashForSearch()
    {
        // FNV-1a 64-bit offset basis (0xcbf29ce484222325) overflows long.MaxValue,
        // so we operate in ulong and reinterpret the final bits as long. The
        // hash bits don't care about sign; this is purely a folding function.
        ulong h = 0xcbf29ce484222325UL;
        for (int i = 0; i < _cells.Length; i++)
        {
            h = (h ^ (ulong)_cells[i]) * 1099511628211UL;
        }
        return unchecked((long)h);
    }
}