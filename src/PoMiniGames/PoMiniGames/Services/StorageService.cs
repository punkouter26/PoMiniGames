using System.Text.Json;
using Microsoft.Data.Sqlite;
using PoMiniGames.DTOs;
using PoMiniGames.Models;

namespace PoMiniGames.Services;

/// <summary>
/// SQLite-backed storage service using a single shared database file.
/// </summary>
public class StorageService
{
    private readonly string _dbPath;
    private readonly string _dbFileName;

    private const string CreateTableSql = """
        CREATE TABLE IF NOT EXISTS PlayerStats (
            Game       TEXT NOT NULL,
            PlayerName TEXT NOT NULL,
            StatsJson  TEXT NOT NULL,
            CreatedAt  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            UpdatedAt  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            PRIMARY KEY (Game, PlayerName)
        );
        """;

    private const string CreateMigrationsTableSql = """
        CREATE TABLE IF NOT EXISTS _Migrations (
            Name      TEXT NOT NULL PRIMARY KEY,
            AppliedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        """;

    public StorageService(IConfiguration configuration)
    {
        var dataDir = configuration["Sqlite:DataDirectory"]
            ?? Path.Combine(AppContext.BaseDirectory, "data");

        Directory.CreateDirectory(dataDir);

        var databaseFileName = configuration["Sqlite:DatabaseFileName"];
        if (string.IsNullOrWhiteSpace(databaseFileName))
            databaseFileName = "pominigames.db";

        _dbFileName = Path.GetFileName(databaseFileName);
        _dbPath = Path.Combine(dataDir, _dbFileName);

        using var _ = OpenConnection();
        MigrateLegacyPerGameDatabases(dataDir);
    }

    private void MigrateLegacyPerGameDatabases(string dataDir)
    {
        const string migrationName = "LegacyPerGameImport";

        using var conn = OpenConnection();

        // Skip if already applied on a previous startup.
        using var checkCmd = conn.CreateCommand();
        checkCmd.CommandText = "SELECT COUNT(*) FROM _Migrations WHERE Name = $name";
        checkCmd.Parameters.AddWithValue("$name", migrationName);
        if ((long)(checkCmd.ExecuteScalar() ?? 0L) > 0)
            return;

        var legacyFiles = Directory
            .GetFiles(dataDir, "*.db", SearchOption.TopDirectoryOnly)
            .Where(f => !string.Equals(Path.GetFileName(f), _dbFileName, StringComparison.OrdinalIgnoreCase))
            .ToList();

        foreach (var legacyFile in legacyFiles)
        {
            var game = SanitizeName(Path.GetFileNameWithoutExtension(legacyFile));
            if (string.IsNullOrWhiteSpace(game))
                continue;

            try
            {
                using var legacyConn = new SqliteConnection($"Data Source={legacyFile}");
                legacyConn.Open();

                using var legacyCmd = legacyConn.CreateCommand();
                legacyCmd.CommandText = "SELECT PlayerName, StatsJson FROM PlayerStats";

                using var reader = legacyCmd.ExecuteReader();
                while (reader.Read())
                {
                    var playerName = SanitizeName(reader.GetString(0));
                    if (string.IsNullOrWhiteSpace(playerName))
                        continue;

                    var statsJson = reader.GetString(1);

                    using var insertCmd = conn.CreateCommand();
                    insertCmd.CommandText = """
                        INSERT INTO PlayerStats (Game, PlayerName, StatsJson, CreatedAt, UpdatedAt)
                        VALUES ($game, $name, $json, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                        ON CONFLICT(Game, PlayerName) DO UPDATE SET
                            StatsJson = excluded.StatsJson,
                            UpdatedAt = excluded.UpdatedAt;
                        """;
                    insertCmd.Parameters.AddWithValue("$game", game);
                    insertCmd.Parameters.AddWithValue("$name", playerName);
                    insertCmd.Parameters.AddWithValue("$json", statsJson);
                    insertCmd.ExecuteNonQuery();
                }
            }
            catch
            {
                // Ignore invalid or non-legacy DB files in the data folder.
            }
        }

        // Mark migration as applied regardless of whether any legacy files were found.
        using var recordCmd = conn.CreateCommand();
        recordCmd.CommandText = "INSERT OR IGNORE INTO _Migrations (Name) VALUES ($name)";
        recordCmd.Parameters.AddWithValue("$name", migrationName);
        recordCmd.ExecuteNonQuery();
    }

    private SqliteConnection OpenConnection()
    {
        var conn = new SqliteConnection($"Data Source={_dbPath}");
        conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = CreateTableSql + CreateMigrationsTableSql;
        cmd.ExecuteNonQuery();

        return conn;
    }

    public async Task<List<PlayerStatsDto>> GetAllPlayerStatsAsync()
    {
        var result = new List<PlayerStatsDto>();

        using var conn = OpenConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT Game, PlayerName, StatsJson FROM PlayerStats";

        using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var stats = JsonSerializer.Deserialize<PlayerStats>(reader.GetString(2)) ?? new PlayerStats();
            result.Add(new PlayerStatsDto
            {
                Game = reader.GetString(0),
                Name = reader.GetString(1),
                Stats = stats,
            });
        }

        return result;
    }

    public async Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName)
    {
        var sanitizedGame = SanitizeName(game);
        var sanitizedName = SanitizeName(playerName);
        if (string.IsNullOrWhiteSpace(sanitizedGame) || string.IsNullOrWhiteSpace(sanitizedName))
            return null;

        using var conn = OpenConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT StatsJson FROM PlayerStats WHERE Game = $game AND PlayerName = $name";
        cmd.Parameters.AddWithValue("$game", sanitizedGame);
        cmd.Parameters.AddWithValue("$name", sanitizedName);

        var raw = (string?)await cmd.ExecuteScalarAsync();
        return raw is null ? null : JsonSerializer.Deserialize<PlayerStats>(raw);
    }

    public async Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats)
    {
        var sanitizedGame = SanitizeName(game);
        var sanitizedName = SanitizeName(playerName);

        if (string.IsNullOrWhiteSpace(sanitizedGame))
            throw new ArgumentException("Game cannot be empty", nameof(game));

        if (string.IsNullOrWhiteSpace(sanitizedName))
            throw new ArgumentException("Player name cannot be empty", nameof(playerName));

        stats.UpdatedAt = DateTime.UtcNow;
        var json = JsonSerializer.Serialize(stats);
        var now = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");

        using var conn = OpenConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO PlayerStats (Game, PlayerName, StatsJson, CreatedAt, UpdatedAt)
            VALUES ($game, $name, $json, $now, $now)
            ON CONFLICT(Game, PlayerName) DO UPDATE SET
                StatsJson = excluded.StatsJson,
                UpdatedAt = excluded.UpdatedAt;
            """;

        cmd.Parameters.AddWithValue("$game", sanitizedGame);
        cmd.Parameters.AddWithValue("$name", sanitizedName);
        cmd.Parameters.AddWithValue("$json", json);
        cmd.Parameters.AddWithValue("$now", now);

        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit)
    {
        var sanitizedGame = SanitizeName(game);
        if (string.IsNullOrWhiteSpace(sanitizedGame))
            return [];

        var allPlayers = new List<(string Name, PlayerStats Stats)>();

        using var conn = OpenConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT PlayerName, StatsJson FROM PlayerStats WHERE Game = $game";
        cmd.Parameters.AddWithValue("$game", sanitizedGame);

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
