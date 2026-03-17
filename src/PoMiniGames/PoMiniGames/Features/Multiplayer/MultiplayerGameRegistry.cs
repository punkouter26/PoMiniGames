using System.Text.Json;
using PoMiniGames.Features.Auth;
using static PoMiniGames.Features.Multiplayer.MultiplayerBoardHelpers;

namespace PoMiniGames.Features.Multiplayer;

internal sealed class MultiplayerGameRegistry : IMultiplayerGameRegistry
{
    private readonly Dictionary<string, IMultiplayerGameAdapter> _adapters;
    private readonly SupportedMultiplayerGame[] _supportedGames;

    public MultiplayerGameRegistry()
    {
        var adapters = new IMultiplayerGameAdapter[]
        {
            new TicTacToeGameAdapter(),
            new ConnectFiveGameAdapter(),
            new RealtimeRelayGameAdapter("posnakegame", "PoSnakeGame"),
            new RealtimeRelayGameAdapter("pofight", "PoFight"),
            new RealtimeRelayGameAdapter("voxelshooter", "Voxel Shooter"),
        };

        _adapters = adapters.ToDictionary(adapter => adapter.GameKey, StringComparer.OrdinalIgnoreCase);
        _supportedGames = adapters
            .Select(adapter => new SupportedMultiplayerGame(adapter.GameKey, adapter.DisplayName, adapter.Mode, true))
            .ToArray();
    }

    public IReadOnlyCollection<SupportedMultiplayerGame> GetSupportedGames() => _supportedGames;

    public bool TryGetAdapter(string gameKey, out IMultiplayerGameAdapter? adapter) =>
        _adapters.TryGetValue(gameKey, out adapter);
}

internal sealed class TicTacToeGameAdapter : IMultiplayerGameAdapter
{
    public string GameKey => "tictactoe";

    public string DisplayName => "Tic Tac Toe";

    public MultiplayerTransportMode Mode => MultiplayerTransportMode.TurnBased;

    public object CreateInitialState(MutableMultiplayerMatch match)
    {
        var board = CreateBoard(6, 6);
        return new TicTacToeMultiplayerState(board, match.PlayerOne.UserId, match.PlayerTwo!.UserId, 0);
    }

    public GameTurnResult ApplyTurn(MutableMultiplayerMatch match, AuthenticatedUser actor, JsonElement action)
    {
        if (match.State is not TicTacToeMultiplayerState state)
        {
            return new GameTurnResult(false, "Match state is unavailable.", null, match.CurrentTurnUserId, match.Status, match.WinnerUserId, match.Result);
        }

        if (match.CurrentTurnUserId is null || !string.Equals(match.CurrentTurnUserId, actor.UserId, StringComparison.Ordinal))
        {
            return new GameTurnResult(false, "It is not your turn.", state, match.CurrentTurnUserId, match.Status, match.WinnerUserId, match.Result);
        }

        if (!action.TryGetProperty("row", out var rowElement) || !action.TryGetProperty("col", out var colElement))
        {
            return new GameTurnResult(false, "Expected row and col in the action payload.", state, match.CurrentTurnUserId, match.Status, match.WinnerUserId, match.Result);
        }

        var row = rowElement.GetInt32();
        var col = colElement.GetInt32();
        if (row < 0 || row >= 6 || col < 0 || col >= 6)
        {
            return new GameTurnResult(false, "Move is outside the board.", state, match.CurrentTurnUserId, match.Status, match.WinnerUserId, match.Result);
        }

        if (state.Board[row][col] != 0)
        {
            return new GameTurnResult(false, "Cell is already occupied.", state, match.CurrentTurnUserId, match.Status, match.WinnerUserId, match.Result);
        }

        var piece = string.Equals(actor.UserId, state.XUserId, StringComparison.Ordinal) ? 1 : 2;
        var board = CloneBoard(state.Board);
        board[row][col] = piece;
        var nextState = new TicTacToeMultiplayerState(board, state.XUserId, state.OUserId, state.MoveCount + 1);

        if (HasLine(board, 4, piece))
        {
            return new GameTurnResult(true, null, nextState, null, MultiplayerMatchStatus.Completed, actor.UserId, $"{actor.DisplayName} won the match.");
        }

        if (IsBoardFull(board))
        {
            return new GameTurnResult(true, null, nextState, null, MultiplayerMatchStatus.Completed, null, "The match ended in a draw.");
        }

        var nextTurnUserId = string.Equals(actor.UserId, state.XUserId, StringComparison.Ordinal)
            ? state.OUserId
            : state.XUserId;
        return new GameTurnResult(true, null, nextState, nextTurnUserId, MultiplayerMatchStatus.InProgress, null, null);
    }
}

internal sealed class ConnectFiveGameAdapter : IMultiplayerGameAdapter
{
    public string GameKey => "connectfive";

    public string DisplayName => "Connect Five";

    public MultiplayerTransportMode Mode => MultiplayerTransportMode.TurnBased;

    public object CreateInitialState(MutableMultiplayerMatch match)
    {
        var board = CreateBoard(9, 9);
        return new ConnectFiveMultiplayerState(board, match.PlayerOne.UserId, match.PlayerTwo!.UserId, 0);
    }

    public GameTurnResult ApplyTurn(MutableMultiplayerMatch match, AuthenticatedUser actor, JsonElement action)
    {
        if (match.State is not ConnectFiveMultiplayerState state)
        {
            return new GameTurnResult(false, "Match state is unavailable.", null, match.CurrentTurnUserId, match.Status, match.WinnerUserId, match.Result);
        }

        if (match.CurrentTurnUserId is null || !string.Equals(match.CurrentTurnUserId, actor.UserId, StringComparison.Ordinal))
        {
            return new GameTurnResult(false, "It is not your turn.", state, match.CurrentTurnUserId, match.Status, match.WinnerUserId, match.Result);
        }

        if (!action.TryGetProperty("column", out var columnElement))
        {
            return new GameTurnResult(false, "Expected column in the action payload.", state, match.CurrentTurnUserId, match.Status, match.WinnerUserId, match.Result);
        }

        var column = columnElement.GetInt32();
        if (column < 0 || column >= 9)
        {
            return new GameTurnResult(false, "Column is outside the board.", state, match.CurrentTurnUserId, match.Status, match.WinnerUserId, match.Result);
        }

        var board = CloneBoard(state.Board);
        var targetRow = FindTargetRow(board, column);
        if (targetRow < 0)
        {
            return new GameTurnResult(false, "That column is full.", state, match.CurrentTurnUserId, match.Status, match.WinnerUserId, match.Result);
        }

        var piece = string.Equals(actor.UserId, state.RedUserId, StringComparison.Ordinal) ? 1 : 2;
        board[targetRow][column] = piece;
        var nextState = new ConnectFiveMultiplayerState(board, state.RedUserId, state.YellowUserId, state.MoveCount + 1);

        if (HasLine(board, 5, piece))
        {
            return new GameTurnResult(true, null, nextState, null, MultiplayerMatchStatus.Completed, actor.UserId, $"{actor.DisplayName} won the match.");
        }

        if (board[0].All(cell => cell != 0))
        {
            return new GameTurnResult(true, null, nextState, null, MultiplayerMatchStatus.Completed, null, "The match ended in a draw.");
        }

        var nextTurnUserId = string.Equals(actor.UserId, state.RedUserId, StringComparison.Ordinal)
            ? state.YellowUserId
            : state.RedUserId;
        return new GameTurnResult(true, null, nextState, nextTurnUserId, MultiplayerMatchStatus.InProgress, null, null);
    }
}

internal sealed class RealtimeRelayGameAdapter(string gameKey, string displayName) : IMultiplayerGameAdapter
{
    public string GameKey { get; } = gameKey;

    public string DisplayName { get; } = displayName;

    public MultiplayerTransportMode Mode => MultiplayerTransportMode.Realtime;

    public object CreateInitialState(MutableMultiplayerMatch match) => new RealtimeRelayState("live", 0);

    public GameTurnResult ApplyTurn(MutableMultiplayerMatch match, AuthenticatedUser actor, JsonElement action) =>
        new(false, $"{DisplayName} uses realtime input relay instead of turn submissions.", match.State, null, match.Status, match.WinnerUserId, match.Result);
}

internal static class MultiplayerBoardHelpers
{
    public static int[][] CreateBoard(int rows, int cols) =>
        Enumerable.Range(0, rows)
            .Select(_ => Enumerable.Repeat(0, cols).ToArray())
            .ToArray();

    public static int[][] CloneBoard(int[][] board) => board.Select(row => row.ToArray()).ToArray();

    public static bool IsBoardFull(int[][] board) => board.All(row => row.All(cell => cell != 0));

    public static int FindTargetRow(int[][] board, int column)
    {
        for (var row = board.Length - 1; row >= 0; row--)
        {
            if (board[row][column] == 0)
            {
                return row;
            }
        }

        return -1;
    }

    public static bool HasLine(int[][] board, int winLength, int piece)
    {
        var directions = new[]
        {
            (dr: 0, dc: 1),
            (dr: 1, dc: 0),
            (dr: 1, dc: 1),
            (dr: 1, dc: -1),
        };

        for (var row = 0; row < board.Length; row++)
        {
            for (var col = 0; col < board[row].Length; col++)
            {
                if (board[row][col] != piece)
                {
                    continue;
                }

                foreach (var (dr, dc) in directions)
                {
                    var valid = true;
                    for (var offset = 1; offset < winLength; offset++)
                    {
                        var nextRow = row + (dr * offset);
                        var nextCol = col + (dc * offset);
                        if (nextRow < 0
                            || nextRow >= board.Length
                            || nextCol < 0
                            || nextCol >= board[nextRow].Length
                            || board[nextRow][nextCol] != piece)
                        {
                            valid = false;
                            break;
                        }
                    }

                    if (valid)
                    {
                        return true;
                    }
                }
            }
        }

        return false;
    }
}
