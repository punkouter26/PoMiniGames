using Microsoft.Data.Sqlite;

namespace PoMiniGames.Services;

/// <summary>
/// Handles SQLite schema creation and migration from legacy per-game databases.
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

    private const string CreateMigrationsTableSql = """
        CREATE TABLE IF NOT EXISTS _Migrations (
            Name      TEXT NOT NULL PRIMARY KEY,
            AppliedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
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
        """;

    internal static void InitializeSchema(string dbPath)
    {
        using var conn = new SqliteConnection($"Data Source={dbPath}");
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = CreateTableSql
            + CreateMigrationsTableSql
            + CreateSnakeHighScoresTableSql
            + CreatePoDropSquareHighScoresTableSql
            + CreateIndexesSql;
        cmd.ExecuteNonQuery();
    }

    internal static void MigrateLegacyPerGameDatabases(string dbPath, string dbFileName, string dataDir)
    {
        const string migrationName = "LegacyPerGameImport";

        using var conn = new SqliteConnection($"Data Source={dbPath}");
        conn.Open();

        // Skip if already applied on a previous startup.
        using var checkCmd = conn.CreateCommand();
        checkCmd.CommandText = "SELECT COUNT(*) FROM _Migrations WHERE Name = $name";
        checkCmd.Parameters.AddWithValue("$name", migrationName);
        if ((long)(checkCmd.ExecuteScalar() ?? 0L) > 0)
            return;

        var legacyFiles = Directory
            .GetFiles(dataDir, "*.db", SearchOption.TopDirectoryOnly)
            .Where(f => !string.Equals(Path.GetFileName(f), dbFileName, StringComparison.OrdinalIgnoreCase))
            .ToList();

        foreach (var legacyFile in legacyFiles)
        {
            var game = StorageService.SanitizeName(Path.GetFileNameWithoutExtension(legacyFile));
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
                    var playerName = StorageService.SanitizeName(reader.GetString(0));
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
}
