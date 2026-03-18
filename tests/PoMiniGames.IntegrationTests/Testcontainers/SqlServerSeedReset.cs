using Microsoft.Data.SqlClient;

namespace PoMiniGames.IntegrationTests.Testcontainers;

public static class SqlServerSeedReset
{
    public static async Task InitializeSchemaAsync(string connectionString, CancellationToken cancellationToken = default)
    {
        await ExecuteBatchAsync(connectionString, [
            """
            IF OBJECT_ID(N'dbo.IntegrationProbe', N'U') IS NULL
            BEGIN
                CREATE TABLE dbo.IntegrationProbe
                (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    Marker NVARCHAR(64) NOT NULL,
                    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
                );
            END;
            """
        ], cancellationToken);
    }

    public static async Task ResetAsync(string connectionString, CancellationToken cancellationToken = default)
    {
        await ExecuteBatchAsync(connectionString, [
            """
            IF OBJECT_ID(N'dbo.IntegrationProbe', N'U') IS NOT NULL
            BEGIN
                DELETE FROM dbo.IntegrationProbe;
            END;
            """
        ], cancellationToken);
    }

    public static async Task SeedAsync(string connectionString, IReadOnlyCollection<string> statements, CancellationToken cancellationToken = default)
    {
        await ExecuteBatchAsync(connectionString, statements, cancellationToken);
    }

    private static async Task ExecuteBatchAsync(string connectionString, IEnumerable<string> statements, CancellationToken cancellationToken)
    {
        await using var conn = new SqlConnection(connectionString);
        await conn.OpenAsync(cancellationToken);

        foreach (var statement in statements)
        {
            if (string.IsNullOrWhiteSpace(statement))
            {
                continue;
            }

            await using var cmd = conn.CreateCommand();
            cmd.CommandText = statement;
            await cmd.ExecuteNonQueryAsync(cancellationToken);
        }
    }
}
