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

    // PoBrawl demo-mode fighter Elo (one row per fighter, head-to-head ratings)
    Task<List<PoBrawlFighterRating>> GetPoBrawlFighterRatingsAsync(int limit = 10);

    /// <summary>
    /// Records one CPU-vs-CPU demo match and moves both fighters' ratings. The server owns the
    /// Elo arithmetic — callers submit only who fought and who won.
    /// </summary>
    /// <param name="winnerFighterId">Winning fighter, or either side when <paramref name="isDraw"/>.</param>
    /// <param name="loserFighterId">Losing fighter, or the other side when <paramref name="isDraw"/>.</param>
    /// <returns>
    /// The re-ranked board, same shape as <see cref="GetPoBrawlFighterRatingsAsync"/>. Returning
    /// only the two changed rows would be useless on its own — a rating reads against the
    /// ranking — and every caller followed the write with a board fetch anyway.
    /// </returns>
    Task<List<PoBrawlFighterRating>> RecordPoBrawlDemoResultAsync(
        string winnerFighterId, string loserFighterId, bool isDraw);

    // PoSports High Scores (lowest combined meet time wins, one row per player)
    Task<List<PoSportsHighScore>> GetPoSportsHighScoresAsync(int limit = 10);
    Task<PoSportsHighScore> SavePoSportsHighScoreAsync(PoSportsHighScore entry);

    // PoVoxelStrike High Scores (highest run score wins, one ratcheted row per player)
    Task<List<PoVoxelStrikeHighScore>> GetPoVoxelStrikeHighScoresAsync(int limit = 10);
    Task<PoVoxelStrikeHighScore> SavePoVoxelStrikeHighScoreAsync(PoVoxelStrikeHighScore entry);
}
