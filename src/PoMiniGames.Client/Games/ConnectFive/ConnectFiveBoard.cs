using PoMiniGamesClient.Enums;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Games.ConnectFive;

public class ConnectFiveBoard
{
    public const int Rows = 9;
    public const int Cols = 9;
    public const int WinLength = 5;

    private readonly Piece[][] _cells;

    public ConnectFiveBoard()
    {
        _cells = new Piece[Rows][];
        for (int r = 0; r < Rows; r++)
        {
            _cells[r] = new Piece[Cols];
        }
    }

    public Piece Get(int row, int col) => _cells[row][col];

    public int GetTargetRow(int col)
    {
        for (int r = Rows - 1; r >= 0; r--)
        {
            if (_cells[r][col] == Piece.None) return r;
        }
        return -1;
    }

    public ConnectFiveBoard Place(int row, int col, Piece value)
    {
        var newBoard = new ConnectFiveBoard();
        for (int r = 0; r < Rows; r++)
        {
            for (int c = 0; c < Cols; c++)
            {
                newBoard._cells[r][c] = _cells[r][c];
            }
        }
        newBoard._cells[row][col] = value;
        return newBoard;
    }

    public WinResult CheckWin(Piece player)
    {
        var directions = new[] { (0, 1), (1, 0), (1, 1), (1, -1) };

        for (int r = 0; r < Rows; r++)
        {
            for (int c = 0; c < Cols; c++)
            {
                foreach (var (dr, dc) in directions)
                {
                    var cells = new List<(int, int)>();
                    bool valid = true;
                    for (int i = 0; i < WinLength; i++)
                    {
                        var nr = r + dr * i;
                        var nc = c + dc * i;
                        if (nr < 0 || nr >= Rows || nc < 0 || nc >= Cols || _cells[nr][nc] != player)
                        {
                            valid = false;
                            break;
                        }
                        cells.Add((nr, nc));
                    }
                    if (valid)
                    {
                        return new WinResult { Won = true, Cells = cells };
                    }
                }
            }
        }
        return new WinResult { Won = false, Cells = new List<(int, int)>() };
    }

    public bool IsFull()
    {
        for (int r = 0; r < Rows; r++)
        {
            for (int c = 0; c < Cols; c++)
            {
                if (_cells[r][c] == Piece.None) return false;
            }
        }
        return true;
    }

    public List<int> GetAvailableCols()
    {
        var cols = new List<int>();
        for (int c = 0; c < Cols; c++)
        {
            if (GetTargetRow(c) >= 0) cols.Add(c);
        }
        return cols;
    }
}
