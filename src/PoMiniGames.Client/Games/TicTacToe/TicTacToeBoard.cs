using PoMiniGamesClient.Enums;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Games.TicTacToe;

public class TicTacToeBoard
{
    public const int Size = 6;
    public const int WinLength = 4;

    private readonly CellValue[][] _cells;

    public TicTacToeBoard()
    {
        _cells = new CellValue[Size][];
        for (int r = 0; r < Size; r++)
        {
            _cells[r] = new CellValue[Size];
        }
    }

    public CellValue Get(int row, int col) => _cells[row][col];

    public TicTacToeBoard Place(int row, int col, CellValue value)
    {
        if (_cells[row][col] != CellValue.None)
        {
            throw new Exception($"Cell ({row}, {col}) is already occupied");
        }

        var newBoard = new TicTacToeBoard();
        for (int r = 0; r < Size; r++)
        {
            for (int c = 0; c < Size; c++)
            {
                newBoard._cells[r][c] = _cells[r][c];
            }
        }
        newBoard._cells[row][col] = value;
        return newBoard;
    }

    public WinResult CheckWin(CellValue player)
    {
        var directions = new[] { (0, 1), (1, 0), (1, 1), (1, -1) };

        for (int r = 0; r < Size; r++)
        {
            for (int c = 0; c < Size; c++)
            {
                foreach (var (dr, dc) in directions)
                {
                    var cells = new List<(int, int)>();
                    bool valid = true;
                    for (int i = 0; i < WinLength; i++)
                    {
                        var nr = r + dr * i;
                        var nc = c + dc * i;
                        if (nr < 0 || nr >= Size || nc < 0 || nc >= Size || _cells[nr][nc] != player)
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
        for (int r = 0; r < Size; r++)
        {
            for (int c = 0; c < Size; c++)
            {
                if (_cells[r][c] == CellValue.None) return false;
            }
        }
        return true;
    }

    public List<(int Row, int Col)> GetAvailableMoves()
    {
        var moves = new List<(int, int)>();
        for (int r = 0; r < Size; r++)
        {
            for (int c = 0; c < Size; c++)
            {
                if (_cells[r][c] == CellValue.None)
                {
                    moves.Add((r, c));
                }
            }
        }
        return moves;
    }
}
