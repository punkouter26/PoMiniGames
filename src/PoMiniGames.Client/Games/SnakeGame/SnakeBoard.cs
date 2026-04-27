namespace PoMiniGamesClient.Games.SnakeGame;

public enum SnakeCell { Empty, Snake, Food }

public enum MoveResult { Continue, GameOver, Win }

public class SnakeBoard
{
    public const int Rows = 20;
    public const int Cols = 20;
    
    private readonly SnakeCell[][] _cells;
    private List<(int Row, int Col)> _snake = new();
    private (int Row, int Col) _direction = (0, 1);
    private int _score;
    
    public int Score => _score;
    
    public SnakeBoard()
    {
        _cells = new SnakeCell[Rows][];
        for (int r = 0; r < Rows; r++)
        {
            _cells[r] = new SnakeCell[Cols];
        }
        Reset();
    }
    
    public void Reset()
    {
        for (int r = 0; r < Rows; r++)
            for (int c = 0; c < Cols; c++)
                _cells[r][c] = SnakeCell.Empty;
        
        _snake = new List<(int Row, int Col)> { (10, 5), (10, 4), (10, 3) };
        foreach (var seg in _snake)
            _cells[seg.Row][seg.Col] = SnakeCell.Snake;
        
        _direction = (0, 1);
        _score = 0;
        SpawnFood();
    }
    
    public SnakeCell GetCell(int row, int col) => _cells[row][col];
    
    public void SetDirection(int dRow, int dCol)
    {
        // Prevent 180-degree turns
        if (_direction.Row + dRow != 0 || _direction.Col + dCol != 0)
            _direction = (dRow, dCol);
    }
    
    private void SpawnFood()
    {
        var empty = new List<(int Row, int Col)>();
        for (int r = 0; r < Rows; r++)
            for (int c = 0; c < Cols; c++)
                if (_cells[r][c] == SnakeCell.Empty)
                    empty.Add((r, c));
        
        if (empty.Count > 0)
        {
            var pos = empty[Random.Shared.Next(empty.Count)];
            _cells[pos.Row][pos.Col] = SnakeCell.Food;
        }
    }
    
    public MoveResult Move()
    {
        var head = _snake[0];
        var newHead = (Row: head.Row + _direction.Row, Col: head.Col + _direction.Col);
        
        // Boundary check
        if (newHead.Row < 0 || newHead.Row >= Rows || newHead.Col < 0 || newHead.Col >= Cols)
            return MoveResult.GameOver;
        
        // Self collision (check all except tail which will move)
        for (int i = 0; i < _snake.Count - 1; i++)
        {
            if (_snake[i].Row == newHead.Row && _snake[i].Col == newHead.Col)
                return MoveResult.GameOver;
        }
        
        var ate = _cells[newHead.Row][newHead.Col] == SnakeCell.Food;
        
        // Remove tail
        var tail = _snake[^1];
        _cells[tail.Row][tail.Col] = SnakeCell.Empty;
        _snake.RemoveAt(_snake.Count - 1);
        
        // Add new head
        _snake.Insert(0, newHead);
        _cells[newHead.Row][newHead.Col] = SnakeCell.Snake;
        
        if (ate)
        {
            _score += 10;
            SpawnFood();
        }
        
        return MoveResult.Continue;
    }
}
