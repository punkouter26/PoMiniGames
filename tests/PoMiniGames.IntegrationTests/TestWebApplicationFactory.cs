using DotNet.Testcontainers.Builders;
using DotNet.Testcontainers.Containers;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using PoMiniGames.Features.Auth;

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

    // Captured at app-configuration time so it reflects the FINAL resolved environment, even when
    // a test overrides it to Production via WithWebHostBuilder(builder => builder.UseEnvironment(...)).
    private bool _finalEnvIsProduction;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.ConfigureAppConfiguration((context, cfg) =>
        {
            _finalEnvIsProduction = string.Equals(
                context.HostingEnvironment.EnvironmentName, "Production", StringComparison.OrdinalIgnoreCase);

            var overrides = new Dictionary<string, string?>();

            if (_azuriteConnectionString is not null)
            {
                overrides["PoMiniGames:Storage:TableService:ConnectionString"] = _azuriteConnectionString;
                overrides["PoMiniGames:Storage:TableService:TableName"] = "pominigames";
            }

            cfg.AddInMemoryCollection(overrides);
        });
        builder.ConfigureTestServices(services =>
        {
            // Rule §2: register the FakeAuth scheme additively in the test host. Tests assert
            // identity variations by injecting X-Fake-User / X-Fake-Roles per request.
            // Never register it when a test simulates Production — the runtime production guard
            // (Program.cs) forbids fake auth there, and a faithful harness must honour that.
            if (_finalEnvIsProduction)
            {
                return;
            }

            services.AddAuthentication(options =>
            {
                options.DefaultAuthenticateScheme = FakeAuthHandler.SchemeName;
                options.DefaultChallengeScheme = FakeAuthHandler.SchemeName;
                options.DefaultScheme = FakeAuthHandler.SchemeName;
            })
            .AddScheme<AuthenticationSchemeOptions, FakeAuthHandler>(FakeAuthHandler.SchemeName, _ => { });
        });
    }

    /// <summary>
    /// Every test client is authenticated by default as "test-user" via the FakeAuth header.
    /// Individual tests can override or remove this header to assert other identities / anonymous access.
    /// </summary>
    protected override void ConfigureClient(HttpClient client)
    {
        client.DefaultRequestHeaders.Add(FakeAuthHandler.UserHeader, "test-user");
        base.ConfigureClient(client);
    }
}
