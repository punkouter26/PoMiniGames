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

    // PoRacer High Scores (lowest race time wins)
    Task<List<PoRacerHighScore>> GetPoRacerHighScoresAsync(int limit = 10);
    Task<PoRacerHighScore> SavePoRacerHighScoreAsync(PoRacerHighScore entry);

    // PoBrawl presidents-ladder leaderboard (one row per player, best-ever progress)
    Task<List<PoBrawlLadderEntry>> GetPoBrawlLadderAsync(int limit = 10);
    Task<PoBrawlLadderEntry> SavePoBrawlLadderAsync(PoBrawlLadderEntry entry);

    // PoClick High Scores (highest accuracy score wins)
    Task<List<PoClickHighScore>> GetPoClickHighScoresAsync(int limit = 10);
    Task<PoClickHighScore> SavePoClickHighScoreAsync(PoClickHighScore entry);
}
