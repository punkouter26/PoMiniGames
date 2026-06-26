using PoMiniGames.Application.DTOs;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Application.Services;

/// <summary>
/// Unified storage abstraction for player stats, snake high scores, and PoDropSquare high scores.
/// </summary>
public interface IStorageService
{
    // Player Stats
    IAsyncEnumerable<PlayerStatsDto> GetAllPlayerStatsAsync(CancellationToken cancellationToken = default);
    Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName);
    Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats);
    Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit, string? difficulty = null);

    // Snake High Scores
    Task<List<SnakeHighScore>> GetSnakeHighScoresAsync(int limit = 10);
    Task<SnakeHighScore> SaveSnakeHighScoreAsync(SnakeHighScore entry);

    // PoDropSquare High Scores
    Task<List<PoDropSquareHighScore>> GetPoDropSquareHighScoresAsync(int limit = 10);
    Task<PoDropSquareHighScore> SavePoDropSquareHighScoreAsync(PoDropSquareHighScore entry);

    // PoMarbleRace High Scores
    Task<List<MarbleRaceHighScore>> GetMarbleRaceHighScoresAsync(int limit = 10);
    Task<MarbleRaceHighScore> SaveMarbleRaceHighScoreAsync(MarbleRaceHighScore entry);
}
