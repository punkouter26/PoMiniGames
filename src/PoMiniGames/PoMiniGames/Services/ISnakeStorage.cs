using PoMiniGames.Models;

namespace PoMiniGames.Services;

/// <summary>
/// Narrow storage contract for the PoSnakeGame high-score feature slice.
/// </summary>
public interface ISnakeStorage
{
    Task<List<SnakeHighScore>> GetSnakeHighScoresAsync(int limit = 10);
    Task<SnakeHighScore> SaveSnakeHighScoreAsync(SnakeHighScore entry);
}
