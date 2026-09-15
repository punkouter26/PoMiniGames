namespace PoMiniGames.Shared.Games;

// ────────────────────────────  Rules  ─────────────────────────────
//
// The one gravity + five-in-a-row implementation. The client board
// (Games/ConnectFive/ConnectFiveBoard.cs) delegates its win check here and
// the online match service applies every move through it, so a disc the
// server accepts is a disc the client would have drawn — there is no second
// copy of the rules to drift.

/// <summary>
/// Board geometry and the pure rules of Connect Five over a flat, row-major
/// <c>byte[Rows * Cols]</c> where a cell holds <see cref="Empty"/>, <see cref="Red"/>
/// or <see cref="Yellow"/>. Row 0 is the top of the board; discs fall to the
/// highest-numbered empty row of their column.
/// </summary>
public static class ConnectFiveRules
{
    public const int Rows = 9;
    public const int Cols = 9;
    public const int WinLength = 5;
    public const int CellCount = Rows * Cols;

    public const byte Empty = 0;
    public const byte Red = 1;
    public const byte Yellow = 2;

    /// <summary>The row a disc dropped in <paramref name="col"/> lands on, or -1 when the column is full.</summary>
    public static int TargetRow(ReadOnlySpan<byte> cells, int col)
    {
        if (col < 0 || col >= Cols) return -1;
        for (int r = Rows - 1; r >= 0; r--)
        {
            if (cells[r * Cols + col] == Empty) return r;
        }
        return -1;
    }

    public static bool IsFull(ReadOnlySpan<byte> cells)
    {
        // Only the top row can hold the last empty cell of any column.
        for (int c = 0; c < Cols; c++)
        {
            if (cells[c] == Empty) return false;
        }
        return true;
    }

    /// <summary>
    /// Flat cell indices of the first five-in-a-row found for <paramref name="colour"/>,
    /// in line order, or <c>null</c> when there is none.
    /// </summary>
    /// <remarks>
    /// Scans every anchor cell in four directions and validates the FULL window
    /// from the anchor (i = 0). An earlier client-side copy started at i = 1, so a
    /// run of four plus an unchecked anchor reported a "win" whose fifth highlighted
    /// cell was empty — the reason the window starts at zero is that bug.
    /// </remarks>
    public static int[]? FindWin(ReadOnlySpan<byte> cells, byte colour)
    {
        if (colour == Empty) throw new ArgumentException("Cannot check a win for the empty cell.", nameof(colour));
        ReadOnlySpan<(int dr, int dc)> directions = [(0, 1), (1, 0), (1, 1), (1, -1)];

        for (int r = 0; r < Rows; r++)
        {
            for (int c = 0; c < Cols; c++)
            {
                if (cells[r * Cols + c] != colour) continue;
                foreach (var (dr, dc) in directions)
                {
                    var endR = r + dr * (WinLength - 1);
                    var endC = c + dc * (WinLength - 1);
                    if (endR < 0 || endR >= Rows || endC < 0 || endC >= Cols) continue;

                    bool valid = true;
                    for (int i = 1; i < WinLength; i++)
                    {
                        if (cells[(r + dr * i) * Cols + (c + dc * i)] != colour) { valid = false; break; }
                    }
                    if (!valid) continue;

                    var line = new int[WinLength];
                    for (int i = 0; i < WinLength; i++) line[i] = (r + dr * i) * Cols + (c + dc * i);
                    return line;
                }
            }
        }
        return null;
    }
}

// ──────────────────────────  Online wire  ─────────────────────────
//
// Contracts for the /connectfive/hub SignalR surface. Enums cross the wire as
// camelCase strings (Program.cs AddJsonProtocol on the server, HubConnectionFactory
// on the client). No lobby, no host, no ready check: a turn-based two-seat game
// only needs a quick-match queue — the first two arrivals are paired and play.

public enum ConnectFiveColour
{
    Red = 1,
    Yellow = 2,
}

public enum ConnectFiveMatchStatus
{
    InProgress,
    RedWon,
    YellowWon,
    Draw,
}

public enum ConnectFiveEndReason
{
    None,
    FiveInARow,
    BoardFull,
    /// <summary>A seat left the match (explicit Leave) while it was in progress.</summary>
    Forfeit,
    /// <summary>A seat dropped and did not come back inside the reconnect grace window.</summary>
    Disconnect,
}

/// <summary>One of the two seats, as every viewer of the match sees it. No connection ids or tokens.</summary>
public sealed record ConnectFiveSeat(
    string DisplayName,
    bool IsGuest,
    ConnectFiveColour Colour,
    bool Connected,
    bool WantsRematch);

/// <summary>
/// Sent to each seat individually when a game begins (first pairing and every
/// rematch). <see cref="SeatToken"/> is the private handle a client presents to
/// <c>Rejoin</c> after a reconnect; it never appears in the shared state.
/// </summary>
public sealed record ConnectFiveMatchStart(
    string MatchId,
    int GameNumber,
    string SeatToken,
    ConnectFiveColour YourColour,
    ConnectFiveSeat Red,
    ConnectFiveSeat Yellow);

public sealed record ConnectFiveMove(int Row, int Col, ConnectFiveColour Colour);

/// <summary>
/// Full authoritative snapshot, broadcast to both seats after every change.
/// <see cref="Cells"/> is the flat <see cref="ConnectFiveRules"/> board;
/// <see cref="WinCells"/> holds flat indices of the winning line when there is one.
/// A client that is exactly one move behind applies <see cref="LastMove"/> so its
/// drop animation plays; any other gap rebuilds from <see cref="Cells"/>.
/// </summary>
public sealed record ConnectFiveMatchState(
    string MatchId,
    int GameNumber,
    byte[] Cells,
    int MoveCount,
    ConnectFiveColour Turn,
    ConnectFiveMatchStatus Status,
    ConnectFiveEndReason EndReason,
    ConnectFiveMove? LastMove,
    int[] WinCells,
    ConnectFiveSeat Red,
    ConnectFiveSeat Yellow,
    DateTimeOffset UpdatedUtc);

/// <summary>Reply to <c>FindMatch</c>. When <see cref="Matched"/> is true a <c>matchStarted</c> event follows.</summary>
public sealed record ConnectFiveQueueStatus(bool Matched, int Waiting);

/// <summary>Reply to <c>Rejoin</c>: the seat's private start record plus the current board.</summary>
public sealed record ConnectFiveRejoinResult(ConnectFiveMatchStart Start, ConnectFiveMatchState State);
