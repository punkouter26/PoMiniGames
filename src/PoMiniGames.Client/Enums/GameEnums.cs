namespace PoMiniGamesClient.Enums;

public enum Difficulty
{
    Easy,
    Medium,
    Hard
}

public enum GameResult
{
    InProgress,
    Win,
    Loss,
    Draw
}

public enum CellValue
{
    None = 0,
    X = 1,
    O = 2
}

public enum Piece
{
    None = 0,
    Red = 1,
    Yellow = 2
}

public enum PlayerToken
{
    None = 0,
    Player1 = 1,
    Player2 = 2
}
