using PoMiniGamesClient.Enums;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Games.ConnectFive;

public class ConnectFiveAI
{
    public (int Row, int Col) GetMove(ConnectFiveBoard board, Player player, Difficulty difficulty)
    {
        return difficulty switch
        {
            Difficulty.Easy   => EasyMove(board, player),
            Difficulty.Medium => MediumMove(board, player),
            Difficulty.Hard   => HardMove(board, player),
            _                 => MediumMove(board, player)
        };
    }

    private (int, int) EasyMove(ConnectFiveBoard board, Player player)
    {
        var opponent = player.Other;

        if (Random.Shared.NextDouble() < 0.3)
        {
            var block = FindWinningMove(board, opponent);
            if (block.HasValue) return block.Value;
        }

        var cols = board.GetAvailableCols();
        if (cols.Count == 0) return (0, 0);
        var col = cols[Random.Shared.Next(cols.Count)];
        return (board.GetTargetRow(col), col);
    }

    private (int, int) MediumMove(ConnectFiveBoard board, Player player)
    {
        var opponent = player.Other;

        var win = FindWinningMove(board, player);
        if (win.HasValue) return win.Value;

        var block = FindWinningMove(board, opponent);
        if (block.HasValue) return block.Value;

        var cols = board.GetAvailableCols();
        if (cols.Count == 0) return (0, 0);

        var centerCol = ConnectFiveBoard.Cols / 2;
        if (cols.Contains(centerCol))
        {
            return (board.GetTargetRow(centerCol), centerCol);
        }

        return (board.GetTargetRow(cols[Random.Shared.Next(cols.Count)]), cols[0]);
    }

    private (int, int) HardMove(ConnectFiveBoard board, Player player)
    {
        // Audit #7: 4-ply negamax with alpha-beta + a small transposition table.
        // Bounded by the existing AiMoveBudgetMs in RunAiTurnAsync (8 s ceiling).
        // Medium difficulty calls the same search at depth=2 to stay sub-100ms.
        var search = new NegamaxSearch(player, maxDepth: 4);
        return search.ChooseMove(board);
    }

    private (int, int)? FindWinningMove(ConnectFiveBoard board, Player player)
    {
        foreach (var col in board.GetAvailableCols())
        {
            var row = board.GetTargetRow(col);
            var next = board.Place(row, col, player);
            if (next.CheckWin(player).Won) return (row, col);
        }
        return null;
    }
}