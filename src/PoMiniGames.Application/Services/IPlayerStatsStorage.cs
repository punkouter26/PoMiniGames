using PoMiniGames.DTOs;
using PoMiniGames.Models;

namespace PoMiniGames.Services;

/// <summary>
/// Narrow storage contract for the Leaderboard feature slice.
/// </summary>
public interface IPlayerStatsStorage
{
    Task<List<PlayerStatsDto>> GetAllPlayerStatsAsync();
    Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName);
    Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats);
    Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit, string? difficulty = null);
}