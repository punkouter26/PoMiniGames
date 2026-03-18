using FluentAssertions;
using Microsoft.Data.SqlClient;
using PoMiniGames.IntegrationTests.Testcontainers;

namespace PoMiniGames.IntegrationTests;

[Collection(SqlServerCollectionDefinition.Name)]
public sealed class MsSqlContainerSmokeTests(SqlServerContainerFixture fixture)
{
    [Fact]
    public async Task SqlContainerSeedAndResetHooksWork()
    {
        if (!fixture.IsEnabled)
        {
            return;
        }

        fixture.ConnectionString.Should().NotBeNullOrWhiteSpace();

        await fixture.ResetAsync();
        await fixture.SeedAsync([
            "INSERT INTO dbo.IntegrationProbe (Marker) VALUES ('first-seed')"
        ]);

        var seededCount = await CountProbeRowsAsync(fixture.ConnectionString!);
        seededCount.Should().Be(1);

        await fixture.ResetAsync();

        var countAfterReset = await CountProbeRowsAsync(fixture.ConnectionString!);
        countAfterReset.Should().Be(0);
    }

    private static async Task<int> CountProbeRowsAsync(string connectionString)
    {
        await using var conn = new SqlConnection(connectionString);
        await conn.OpenAsync();

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM dbo.IntegrationProbe";

        return Convert.ToInt32(await cmd.ExecuteScalarAsync());
    }
}
