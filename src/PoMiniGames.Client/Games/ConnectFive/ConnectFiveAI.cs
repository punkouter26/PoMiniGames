using PoMiniGamesClient.Enums;

namespace PoMiniGamesClient.Games.ConnectFive;

public class ConnectFiveAI
{
    public (int Row, int Col) GetMove(ConnectFiveBoard board, Piece player, Difficulty difficulty)
    {
        return difficulty switch
        {
            Difficulty.Easy => EasyMove(board, player),
            Difficulty.Medium => MediumMove(board, player),
            Difficulty.Hard => HardMove(board, player),
            _ => MediumMove(board, player)
        };
    }

    private (int, int) EasyMove(ConnectFiveBoard board, Piece player)
    {
        var opponent = player == Piece.Red ? Piece.Yellow : Piece.Red;
        
        // 30% chance to block
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

    private (int, int) MediumMove(ConnectFiveBoard board, Piece player)
    {
        var opponent = player == Piece.Red ? Piece.Yellow : Piece.Red;

        // 1. Win if possible
        var win = FindWinningMove(board, player);
        if (win.HasValue) return win.Value;

        // 2. Block opponent
        var block = FindWinningMove(board, opponent);
        if (block.HasValue) return block.Value;

        // 3. Center preference
        var cols = board.GetAvailableCols();
        if (cols.Count == 0) return (0, 0);
        
        var centerCol = ConnectFiveBoard.Cols / 2;
        if (cols.Contains(centerCol))
        {
            return (board.GetTargetRow(centerCol), centerCol);
        }

        return (board.GetTargetRow(cols[Random.Shared.Next(cols.Count)]), cols[0]);
    }

    private (int, int) HardMove(ConnectFiveBoard board, Piece player)
    {
        var opponent = player == Piece.Red ? Piece.Yellow : Piece.Red;
        var bestScore = int.MinValue;
        var bestMove = (Row: -1, Col: -1);

        foreach (var col in board.GetAvailableCols())
        {
            var row = board.GetTargetRow(col);
            var next = board.Place(row, col, player);
            var score = EvaluateBoard(next, player, opponent);
            if (score > bestScore)
            {
                bestScore = score;
                bestMove = (row, col);
            }
        }

        return bestMove.Row >= 0 ? bestMove : (0, 0);
    }

    private int EvaluateBoard(ConnectFiveBoard board, Piece player, Piece opponent)
    {
        int score = 0;
        var directions = new[] { (0, 1), (1, 0), (1, 1), (1, -1) };

        for (int r = 0; r < ConnectFiveBoard.Rows; r++)
        {
            for (int c = 0; c < ConnectFiveBoard.Cols; c++)
            {
                foreach (var (dr, dc) in directions)
                {
                    int mine = 0, theirs = 0, empty = 0;
                    bool valid = true;
                    
                    for (int i = 0; i < ConnectFiveBoard.WinLength; i++)
                    {
                        var nr = r + dr * i;
                        var nc = c + dc * i;
                        if (nr < 0 || nr >= ConnectFiveBoard.Rows || nc < 0 || nc >= ConnectFiveBoard.Cols)
                        {
                            valid = false;
                            break;
                        }
                        var cell = board.Get(nr, nc);
                        if (cell == player) mine++;
                        else if (cell == opponent) theirs++;
                        else empty++;
                    }
                    
                    if (!valid) continue;
                    if (theirs == 0 && mine > 0) score += mine * mine * 10;
                    if (mine == 0 && theirs > 0) score -= theirs * theirs * 10;
                }
            }
        }

        return score;
    }

    private (int, int)? FindWinningMove(ConnectFiveBoard board, Piece player)
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
