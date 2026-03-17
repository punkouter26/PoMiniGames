using PoMiniGames.DTOs;
using PoMiniGames.Models;

namespace PoMiniGames.Services;

/// <summary>
/// Abstraction over the SQLite storage layer.
/// </summary>
public interface IStorageService
{
    Task<List<PlayerStatsDto>> GetAllPlayerStatsAsync();
    Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName);
    Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats);
    Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit);
    Task<List<SnakeHighScore>> GetSnakeHighScoresAsync(int limit = 10);
    Task<SnakeHighScore> SaveSnakeHighScoreAsync(SnakeHighScore entry);
    Task<List<PoDropSquareHighScore>> GetPoDropSquareHighScoresAsync(int limit = 10);
    Task<PoDropSquareHighScore> SavePoDropSquareHighScoreAsync(PoDropSquareHighScore entry);
}
