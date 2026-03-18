using Testcontainers.MsSql;

namespace PoMiniGames.IntegrationTests.Testcontainers;

public sealed class SqlServerContainerFixture : IAsyncLifetime
{
    public const string EnableContainersEnvVar = "POMINI_USE_TESTCONTAINERS";

    private MsSqlContainer? _container;

    public bool IsEnabled =>
        string.Equals(Environment.GetEnvironmentVariable(EnableContainersEnvVar), "true", StringComparison.OrdinalIgnoreCase);

    public string? ConnectionString => _container?.GetConnectionString();

    public async Task InitializeAsync()
    {
        if (!IsEnabled)
        {
            return;
        }

        _container = new MsSqlBuilder("mcr.microsoft.com/mssql/server:2022-latest")
            .Build();

        await _container.StartAsync();
        await SqlServerSeedReset.InitializeSchemaAsync(_container.GetConnectionString());
    }

    public async Task ResetAsync(CancellationToken cancellationToken = default)
    {
        if (ConnectionString is null)
        {
            return;
        }

        await SqlServerSeedReset.ResetAsync(ConnectionString, cancellationToken);
    }

    public async Task SeedAsync(IReadOnlyCollection<string> statements, CancellationToken cancellationToken = default)
    {
        if (ConnectionString is null)
        {
            return;
        }

        await SqlServerSeedReset.SeedAsync(ConnectionString, statements, cancellationToken);
    }

    public async Task DisposeAsync()
    {
        if (_container is not null)
        {
            await _container.DisposeAsync();
            _container = null;
        }
    }
}
