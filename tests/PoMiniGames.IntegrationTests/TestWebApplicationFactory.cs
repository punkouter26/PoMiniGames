using DotNet.Testcontainers.Builders;
using DotNet.Testcontainers.Containers;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace PoMiniGames.IntegrationTests;

/// <summary>
/// Custom <see cref="WebApplicationFactory{TEntryPoint}"/> that points SQLite storage at a
/// unique temp directory and starts an Azurite Table Storage container (when Docker is available)
/// so integration tests require no external services.
/// </summary>
public class TestWebApplicationFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private const string AzuriteAccountKey =
        "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

    private readonly string _tempDir = Path.Combine(Path.GetTempPath(), $"pomini-test-{Guid.NewGuid()}");
    private TestcontainersContainer? _azurite;
    private string? _azuriteConnectionString;

    public async Task InitializeAsync()
    {
        try
        {
            _azurite = new TestcontainersBuilder<TestcontainersContainer>()
                .WithImage("mcr.microsoft.com/azure-storage/azurite:3.33.0")
                .WithCommand("azurite-table", "--tableHost", "0.0.0.0", "--tablePort", "10002")
                .WithPortBinding(10002, assignRandomHostPort: true)
                .WithWaitStrategy(Wait.ForUnixContainer().UntilPortIsAvailable(10002))
                .Build();

            await _azurite.StartAsync();

            var port = _azurite.GetMappedPublicPort(10002);
            _azuriteConnectionString =
                $"DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey={AzuriteAccountKey};"
                + $"TableEndpoint=http://127.0.0.1:{port}/devstoreaccount1;";
        }
        catch
        {
            // Docker not available — integration tests run without table storage.
        }
    }

    Task IAsyncLifetime.DisposeAsync() =>
        _azurite is null ? Task.CompletedTask : _azurite.DisposeAsync().AsTask();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.ConfigureAppConfiguration((_, cfg) =>
        {
            var overrides = new Dictionary<string, string?>
            {
                ["Sqlite:DataDirectory"] = _tempDir,
            };

            if (_azuriteConnectionString is not null)
            {
                overrides["PoMiniGames:Storage:TableService:ConnectionString"] = _azuriteConnectionString;
                overrides["PoMiniGames:Storage:TableService:TableName"] = "pominigames";
            }

            cfg.AddInMemoryCollection(overrides);
        });
        builder.ConfigureTestServices(services =>
        {
            services.AddAuthentication(options =>
            {
                options.DefaultAuthenticateScheme = TestAuthHandler.SchemeName;
                options.DefaultChallengeScheme = TestAuthHandler.SchemeName;
                options.DefaultScheme = TestAuthHandler.SchemeName;
            })
            .AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(TestAuthHandler.SchemeName, _ => { });
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && Directory.Exists(_tempDir))
        {
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(_tempDir, recursive: true); }
            catch { /* best-effort cleanup */ }
        }
    }
}
