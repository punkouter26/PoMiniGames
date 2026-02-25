using System.Text.Json;
using Microsoft.Data.Sqlite;
using PoMiniGames.DTOs;
using PoMiniGames.Models;

namespace PoMiniGames.Services;

/// <summary>
/// SQLite-backed storage service.
/// Each game has its own database file: {DataDirectory}/{game}.db
/// </summary>
public class StorageService
{
    private readonly string _dataDir;

    private const string CreateTableSql = """
        CREATE TABLE IF NOT EXISTS PlayerStats (
            PlayerName TEXT NOT NULL PRIMARY KEY,
            StatsJson  TEXT NOT NULL,
            CreatedAt  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            UpdatedAt  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        """;

    public StorageService(IConfiguration configuration)
    {
        _dataDir = configuration["Sqlite:DataDirectory"]
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        Directory.CreateDirectory(_dataDir);
    }

    // --- Connection -----------------------------------------------------------

    private SqliteConnection OpenConnection(string game)
    {
        var dbPath = Path.Combine(_dataDir, $"{SanitizeName(game)}.db");
        var conn = new SqliteConnection($"Data Source={dbPath}");
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = CreateTableSql;
        cmd.ExecuteNonQuery();
        return conn;
    }

    // --- Read -----------------------------------------------------------------

    /// <summary>Retrieve all player stats across every game.</summary>
    public async Task<List<PlayerStatsDto>> GetAllPlayerStatsAsync()
    {
        var result = new List<PlayerStatsDto>();
        var dbFiles = Directory.GetFiles(_dataDir, "*.db");

        foreach (var file in dbFiles)
        {
            var game = Path.GetFileNameWithoutExtension(file);
            using var conn = new SqliteConnection($"Data Source={file}");
            await conn.OpenAsync();

            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT PlayerName, StatsJson FROM PlayerStats";
            using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                var stats = JsonSerializer.Deserialize<PlayerStats>(reader.GetString(1)) ?? new PlayerStats();
                result.Add(new PlayerStatsDto { Name = reader.GetString(0), Game = game, Stats = stats });
            }
        }

        return result;
    }

    /// <summary>Retrieve stats for one player in a specific game.</summary>
    public async Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName)
    {
        using var conn = OpenConnection(game);
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT StatsJson FROM PlayerStats WHERE PlayerName = $name";
        cmd.Parameters.AddWithValue("$name", SanitizeName(playerName));
        var raw = (string?)await cmd.ExecuteScalarAsync();
        return raw is null ? null : JsonSerializer.Deserialize<PlayerStats>(raw);
    }

    // --- Write ----------------------------------------------------------------

    /// <summary>Upsert player stats for a specific game.</summary>
    public async Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats)
    {
        var sanitizedName = SanitizeName(playerName);
        if (string.IsNullOrWhiteSpace(sanitizedName))
            throw new ArgumentException("Player name cannot be empty", nameof(playerName));

        stats.UpdatedAt = DateTime.UtcNow;
        var json = JsonSerializer.Serialize(stats);
        var now = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");

        using var conn = OpenConnection(game);
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO PlayerStats (PlayerName, StatsJson, CreatedAt, UpdatedAt)
            VALUES ($name, $json, $now, $now)
            ON CONFLICT(PlayerName) DO UPDATE SET
                StatsJson = excluded.StatsJson,
                UpdatedAt = excluded.UpdatedAt;
            """;
        cmd.Parameters.AddWithValue("$name", sanitizedName);
        cmd.Parameters.AddWithValue("$json", json);
        cmd.Parameters.AddWithValue("$now", now);
        await cmd.ExecuteNonQueryAsync();
    }

    // --- Leaderboard ----------------------------------------------------------

    /// <summary>Top players for a given game, sorted by win rate then total games.</summary>
    public async Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit)
    {
        var allPlayers = new List<(string Name, PlayerStats Stats)>();

        using var conn = OpenConnection(game);
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT PlayerName, StatsJson FROM PlayerStats";
        using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var stats = JsonSerializer.Deserialize<PlayerStats>(reader.GetString(1)) ?? new PlayerStats();
            allPlayers.Add((reader.GetString(0), stats));
        }

        return allPlayers
            .OrderByDescending(p => p.Stats.OverallWinRate)
            .ThenByDescending(p => p.Stats.TotalGames)
            .Take(limit)
            .ToList();
    }

    // --- Helpers --------------------------------------------------------------

    /// <summary>Strips characters unsafe for file names.</summary>
    private static string SanitizeName(string input)
    {
        if (string.IsNullOrEmpty(input))
            return string.Empty;

        var invalidChars = Path.GetInvalidFileNameChars()
            .Concat(new[] { '\'', '"', ';', '\\', '/' })
            .ToHashSet();

        var sb = new System.Text.StringBuilder(input.Length);
        foreach (var c in input)
        {
            if (!invalidChars.Contains(c) && c >= 0x20)
                sb.Append(c);
        }
        return sb.ToString().Trim();
    }
}
