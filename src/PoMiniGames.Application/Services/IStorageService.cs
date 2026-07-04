using PoMiniGames.Application.DTOs;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Application.Services;

/// <summary>
/// Unified storage abstraction for player stats and remaining per-game high score boards.
/// </summary>
public interface IStorageService
{
    // Player Stats
    IAsyncEnumerable<PlayerStatsDto> GetAllPlayerStatsAsync(CancellationToken cancellationToken = default);
    Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName);
    Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats);
    Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit, string? difficulty = null);

    // PoMarbleRace High Scores
    Task<List<MarbleRaceHighScore>> GetMarbleRaceHighScoresAsync(int limit = 10);
    Task<MarbleRaceHighScore> SaveMarbleRaceHighScoreAsync(MarbleRaceHighScore entry);

    // PoBrawl High Scores (fastest KO)
    Task<List<PoBrawlHighScore>> GetPoBrawlHighScoresAsync(int limit = 10);
    Task<PoBrawlHighScore> SavePoBrawlHighScoreAsync(PoBrawlHighScore entry);
}
