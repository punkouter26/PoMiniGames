using System.Text.Json;
using Azure.Data.Tables;
using PoMiniGames.DTOs;
using PoMiniGames.Models;

namespace PoMiniGames.Services;

/// <summary>
/// Azure Table Storage entity for player statistics.
/// PartitionKey encodes game type; RowKey is the player name.
/// </summary>
public class PlayerStatsEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty;
    public string RowKey { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public Azure.ETag ETag { get; set; }

    /// <summary>Complex stats serialised as JSON.</summary>
    public string StatsJson { get; set; } = string.Empty;
}

/// <summary>
/// Facade for Azure Table Storage operations.
/// Supports multi-game leaderboards via PartitionKey = game name.
/// </summary>
public class StorageService
{
    private readonly TableClient _tableClient;
    private const string TableName = "PlayerStats";

    public StorageService(TableServiceClient tableServiceClient)
    {
        _tableClient = tableServiceClient.GetTableClient(TableName);
        _tableClient.CreateIfNotExists();
    }

    // ─── Read ──────────────────────────────────────────────────

    /// <summary>Retrieve all player stats across every game.</summary>
    public async Task<List<PlayerStatsDto>> GetAllPlayerStatsAsync()
    {
        var players = new List<PlayerStatsDto>();
        await foreach (var entity in _tableClient.QueryAsync<PlayerStatsEntity>())
        {
            var stats = JsonSerializer.Deserialize<PlayerStats>(entity.StatsJson) ?? new PlayerStats();
            players.Add(new PlayerStatsDto { Name = entity.RowKey, Game = entity.PartitionKey, Stats = stats });
        }

        return players;
    }

    /// <summary>Retrieve stats for one player in a specific game.</summary>
    public async Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName)
    {
        try
        {
            var response = await _tableClient.GetEntityAsync<PlayerStatsEntity>(
                SanitizeKey(game), SanitizeKey(playerName));
            return JsonSerializer.Deserialize<PlayerStats>(response.Value.StatsJson);
        }
        catch
        {
            return null;
        }
    }

    // ─── Write ─────────────────────────────────────────────────

    /// <summary>Upsert player stats for a specific game.</summary>
    public async Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats)
    {
        var sanitizedGame = SanitizeKey(game);
        var sanitizedName = SanitizeKey(playerName);
        if (string.IsNullOrWhiteSpace(sanitizedName))
        {
            throw new ArgumentException("Player name cannot be empty", nameof(playerName));
        }

        stats.UpdatedAt = DateTime.UtcNow;
        var entity = new PlayerStatsEntity
        {
            PartitionKey = sanitizedGame,
            RowKey = sanitizedName,
            StatsJson = JsonSerializer.Serialize(stats),
        };

        await _tableClient.UpsertEntityAsync(entity);
    }

    // ─── Leaderboard ───────────────────────────────────────────

    /// <summary>Top players for a given game, sorted by win rate.</summary>
    public async Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit)
    {
        var allPlayers = new List<(string Name, PlayerStats Stats)>();
        var sanitizedGame = SanitizeKey(game);
        
        // Use parameterized filter - safer than string interpolation
        var filter = TableClient.CreateQueryFilter($"PartitionKey eq {sanitizedGame}");

        await foreach (var entity in _tableClient.QueryAsync<PlayerStatsEntity>(filter: filter))
        {
            var stats = JsonSerializer.Deserialize<PlayerStats>(entity.StatsJson) ?? new PlayerStats();
            allPlayers.Add((entity.RowKey, stats));
        }

        return allPlayers
            .OrderByDescending(p => p.Stats.OverallWinRate)
            .ThenByDescending(p => p.Stats.TotalGames)
            .Take(limit)
            .ToList();
    }

    // ─── Helpers ───────────────────────────────────────────────

    /// <summary>
    /// Sanitises a string for use as Azure Table Storage key.
    /// Removes: / \ # ? and control characters.
    /// </summary>
    private static string SanitizeKey(string input)
    {
        if (string.IsNullOrEmpty(input))
        {
            return string.Empty;
        }

        var sb = new System.Text.StringBuilder(input.Length);
        foreach (var c in input)
        {
            if (c is '/' or '\\' or '#' or '?')
            {
                continue;
            }

            if (c < 0x20 || (c >= 0x7F && c <= 0x9F))
            {
                continue;
            }

            sb.Append(c);
        }

        return sb.ToString().Trim();
    }
}
