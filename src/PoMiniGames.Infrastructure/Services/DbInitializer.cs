using Microsoft.Data.Sqlite;

namespace PoMiniGames.Infrastructure.Services;

/// <summary>
/// Handles SQLite schema creation.
/// Called once at application startup before the service handles any requests.
/// </summary>
internal static class DbInitializer
{
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

    private const string CreateSnakeHighScoresTableSql = """
        CREATE TABLE IF NOT EXISTS SnakeHighScores (
            Id           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            Initials     TEXT NOT NULL,
            Score        INTEGER NOT NULL,
            Date         TEXT NOT NULL,
            GameDuration REAL NOT NULL DEFAULT 30,
            SnakeLength  INTEGER NOT NULL DEFAULT 0,
            FoodEaten    INTEGER NOT NULL DEFAULT 0
        );
        """;

    private const string CreatePoDropSquareHighScoresTableSql = """
        CREATE TABLE IF NOT EXISTS PoDropSquareHighScores (
            Id             INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            PlayerInitials TEXT NOT NULL,
            SurvivalTime   REAL NOT NULL,
            Date           TEXT NOT NULL,
            PlayerName     TEXT NULL
        );
        """;

    private const string CreateIndexesSql = """
        CREATE INDEX IF NOT EXISTS idx_playerstats_game ON PlayerStats(Game);
        CREATE INDEX IF NOT EXISTS idx_ps_game_winrate   ON PlayerStats(Game, json_extract(StatsJson, '$.WinRate')          DESC);
        CREATE INDEX IF NOT EXISTS idx_ps_game_totalg    ON PlayerStats(Game, json_extract(StatsJson, '$.TotalGames')       DESC);
        CREATE INDEX IF NOT EXISTS idx_ps_game_easy_elo  ON PlayerStats(Game, json_extract(StatsJson, '$.Easy.EloRating')   DESC);
        CREATE INDEX IF NOT EXISTS idx_ps_game_med_elo   ON PlayerStats(Game, json_extract(StatsJson, '$.Medium.EloRating') DESC);
        CREATE INDEX IF NOT EXISTS idx_ps_game_hard_elo  ON PlayerStats(Game, json_extract(StatsJson, '$.Hard.EloRating')   DESC);
        """;


    internal static void InitializeSchema(string dbPath)
    {
        using var conn = new SqliteConnection($"Data Source={dbPath};Pooling=True");
        conn.Open();
        using var cmd = conn.CreateCommand();
        // Enable WAL mode for concurrent read/write performance
        cmd.CommandText = "PRAGMA journal_mode=WAL; "
            + CreateTableSql
            + CreateSnakeHighScoresTableSql
            + CreatePoDropSquareHighScoresTableSql
            + CreateIndexesSql;
        cmd.ExecuteNonQuery();
    }
}
