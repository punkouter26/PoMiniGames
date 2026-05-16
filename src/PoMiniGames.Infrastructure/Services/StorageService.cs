using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using PoMiniGames.Application.DTOs;
using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Services;

namespace PoMiniGames.Infrastructure.Services;

/// <summary>
/// SQLite-backed storage service using a single shared database file.
/// </summary>
public class StorageService : IStorageService
{
    private readonly string _dbPath;
    private readonly string _dbFileName;
    private readonly string _dataDir;
    private readonly EloCalculator _eloCalculator;

    internal static readonly HashSet<char> _invalidChars =
        Path.GetInvalidFileNameChars()
            .Concat(new[] { '\'', '"', ';', '\\', '/' })
            .ToHashSet();

    public StorageService(IConfiguration configuration, EloCalculator eloCalculator)
    {
        _eloCalculator = eloCalculator;
        var dataDir = configuration["Sqlite:DataDirectory"]
            ?? Path.Combine(AppContext.BaseDirectory, "data");

        Directory.CreateDirectory(dataDir);

        var databaseFileName = configuration["Sqlite:DatabaseFileName"];
        if (string.IsNullOrWhiteSpace(databaseFileName))
        {
            databaseFileName = "pominigames.db";
        }

        _dbFileName = Path.GetFileName(databaseFileName);
        _dbPath = Path.Combine(dataDir, _dbFileName);
        _dataDir = dataDir;
    }

    /// <summary>
    /// Ensures the shared SQLite schema exists before the app serves requests.
    /// </summary>
    public void Initialize()
    {
        DbInitializer.InitializeSchema(_dbPath);
    }

    private SqliteConnection OpenConnection()
    {
        var conn = new SqliteConnection($"Data Source={_dbPath}");
        conn.Open();
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
        {
            return null;
        }

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
        {
            throw new ArgumentException("Game cannot be empty", nameof(game));
        }

        if (string.IsNullOrWhiteSpace(sanitizedName))
        {
            throw new ArgumentException("Player name cannot be empty", nameof(playerName));
        }

        // Compute ELO ratings server-side before persisting so the stored JSON is always current.
        _eloCalculator.ApplyAll(stats);

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

    public async Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit, string? difficulty = null)
    {
        var sanitizedGame = SanitizeName(game);
        if (string.IsNullOrWhiteSpace(sanitizedGame))
        {
            return [];
        }

        // Normalise the difficulty string: null / empty / "all" → aggregate ranking.
        var diff = difficulty?.Trim().ToLowerInvariant();

        // Push ORDER BY and LIMIT into SQLite using json_extract() so only the top-N rows
        // are deserialised instead of loading the entire table into memory.
        using var conn = OpenConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = diff switch
        {
            "easy" => """
                SELECT PlayerName, StatsJson
                FROM PlayerStats
                WHERE Game = $game
                  AND CAST(COALESCE(json_extract(StatsJson, '$.Easy.TotalGames'), 0) AS INTEGER) > 0
                ORDER BY CAST(COALESCE(json_extract(StatsJson, '$.Easy.EloRating'),   0) AS REAL) DESC,
                         CAST(COALESCE(json_extract(StatsJson, '$.Easy.TotalGames'),  0) AS INTEGER) DESC
                LIMIT $limit
                """,
            "medium" => """
                SELECT PlayerName, StatsJson
                FROM PlayerStats
                WHERE Game = $game
                  AND CAST(COALESCE(json_extract(StatsJson, '$.Medium.TotalGames'), 0) AS INTEGER) > 0
                ORDER BY CAST(COALESCE(json_extract(StatsJson, '$.Medium.EloRating'),   0) AS REAL) DESC,
                         CAST(COALESCE(json_extract(StatsJson, '$.Medium.TotalGames'),  0) AS INTEGER) DESC
                LIMIT $limit
                """,
            "hard" => """
                SELECT PlayerName, StatsJson
                FROM PlayerStats
                WHERE Game = $game
                  AND CAST(COALESCE(json_extract(StatsJson, '$.Hard.TotalGames'), 0) AS INTEGER) > 0
                ORDER BY CAST(COALESCE(json_extract(StatsJson, '$.Hard.EloRating'),   0) AS REAL) DESC,
                         CAST(COALESCE(json_extract(StatsJson, '$.Hard.TotalGames'),  0) AS INTEGER) DESC
                LIMIT $limit
                """,
            // "all" or unrecognised: aggregate win-rate ranking.
            _ => """
                SELECT PlayerName, StatsJson
                FROM PlayerStats
                WHERE Game = $game
                ORDER BY CAST(COALESCE(json_extract(StatsJson, '$.WinRate'),    0) AS REAL) DESC,
                         CAST(COALESCE(json_extract(StatsJson, '$.TotalGames'), 0) AS INTEGER) DESC
                LIMIT $limit
                """,
        };

        cmd.Parameters.AddWithValue("$game", sanitizedGame);
        cmd.Parameters.AddWithValue("$limit", limit);

        var result = new List<(string Name, PlayerStats Stats)>();
        using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var stats = JsonSerializer.Deserialize<PlayerStats>(reader.GetString(1)) ?? new PlayerStats();
            // Backfill ELO for legacy records where EloRating was not yet stored.
            if (stats.TotalGames > 0 &&
                stats.Easy.EloRating == 0 && stats.Medium.EloRating == 0 && stats.Hard.EloRating == 0)
            {
                _eloCalculator.ApplyAll(stats);
            }

            result.Add((reader.GetString(0), stats));
        }

        return result;
    }

    // ── PoSnakeGame high scores ───────────────────────────────────────────

    public async Task<List<SnakeHighScore>> GetSnakeHighScoresAsync(int limit = 10)
    {
        var result = new List<SnakeHighScore>();

        using var conn = OpenConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT Initials, Score, Date, GameDuration, SnakeLength, FoodEaten
            FROM SnakeHighScores
            ORDER BY Score DESC
            LIMIT $limit
            """;
        cmd.Parameters.AddWithValue("$limit", limit);

        using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            result.Add(new SnakeHighScore
            {
                Initials = reader.GetString(0),
                Score = reader.GetInt32(1),
                Date = reader.GetString(2),
                GameDuration = reader.GetDouble(3),
                SnakeLength = reader.GetInt32(4),
                FoodEaten = reader.GetInt32(5),
            });
        }

        return result;
    }

    public async Task<SnakeHighScore> SaveSnakeHighScoreAsync(SnakeHighScore entry)
    {
        var sanitized = entry with
        {
            Initials = entry.Initials.Trim().ToUpperInvariant(),
            Date = string.IsNullOrWhiteSpace(entry.Date)
                           ? DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
                           : entry.Date,
        };

        using var conn = OpenConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO SnakeHighScores (Initials, Score, Date, GameDuration, SnakeLength, FoodEaten)
            VALUES ($initials, $score, $date, $duration, $snakeLen, $foodEaten)
            """;
        cmd.Parameters.AddWithValue("$initials", sanitized.Initials);
        cmd.Parameters.AddWithValue("$score", sanitized.Score);
        cmd.Parameters.AddWithValue("$date", sanitized.Date);
        cmd.Parameters.AddWithValue("$duration", sanitized.GameDuration);
        cmd.Parameters.AddWithValue("$snakeLen", sanitized.SnakeLength);
        cmd.Parameters.AddWithValue("$foodEaten", sanitized.FoodEaten);
        await cmd.ExecuteNonQueryAsync();

        return sanitized;
    }

    // ── PoDropSquare high scores ────────────────────────────────────────

    public async Task<List<PoDropSquareHighScore>> GetPoDropSquareHighScoresAsync(int limit = 10)
    {
        var result = new List<PoDropSquareHighScore>();

        using var conn = OpenConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT PlayerInitials, SurvivalTime, Date, PlayerName
            FROM PoDropSquareHighScores
            ORDER BY SurvivalTime ASC, Date ASC
            LIMIT $limit
            """;
        cmd.Parameters.AddWithValue("$limit", limit);

        using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            result.Add(new PoDropSquareHighScore
            {
                PlayerInitials = reader.GetString(0),
                SurvivalTime = reader.GetDouble(1),
                Date = reader.GetString(2),
                PlayerName = reader.IsDBNull(3) ? null : reader.GetString(3),
            });
        }

        return result;
    }

    public async Task<PoDropSquareHighScore> SavePoDropSquareHighScoreAsync(PoDropSquareHighScore entry)
    {
        var sanitizedInitials = SanitizeName(entry.PlayerInitials)
            .ToUpperInvariant();
        if (sanitizedInitials.Length > 3)
        {
            sanitizedInitials = sanitizedInitials[..3];
        }

        var sanitized = entry with
        {
            PlayerInitials = sanitizedInitials,
            Date = string.IsNullOrWhiteSpace(entry.Date)
                ? DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
                : entry.Date,
            PlayerName = string.IsNullOrWhiteSpace(entry.PlayerName)
                ? null
                : SanitizeName(entry.PlayerName),
        };

        using var conn = OpenConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO PoDropSquareHighScores (PlayerInitials, SurvivalTime, Date, PlayerName)
            VALUES ($initials, $survivalTime, $date, $playerName)
            """;
        cmd.Parameters.AddWithValue("$initials", sanitized.PlayerInitials);
        cmd.Parameters.AddWithValue("$survivalTime", sanitized.SurvivalTime);
        cmd.Parameters.AddWithValue("$date", sanitized.Date);
        cmd.Parameters.AddWithValue("$playerName", (object?)sanitized.PlayerName ?? DBNull.Value);
        await cmd.ExecuteNonQueryAsync();

        return sanitized;
    }

    internal static string SanitizeName(string input)
    {
        if (string.IsNullOrEmpty(input))
        {
            return string.Empty;
        }

        var sb = new System.Text.StringBuilder(input.Length);
        foreach (var c in input)
        {
            if (!_invalidChars.Contains(c) && c >= 0x20)
            {
                sb.Append(c);
            }
        }

        return sb.ToString().Trim();
    }
}
