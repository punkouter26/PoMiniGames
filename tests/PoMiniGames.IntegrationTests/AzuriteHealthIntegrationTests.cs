using System.Net;
using System.Text.Json.Nodes;
using DotNet.Testcontainers.Builders;
using DotNet.Testcontainers.Containers;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;

namespace PoMiniGames.IntegrationTests;

/// <summary>
/// Verifies the API can check Azure Table Storage health against a real Azurite container.
/// </summary>
public sealed class AzuriteHealthIntegrationTests : IAsyncLifetime
{
    private const string DevStoreAccountName = "devstoreaccount1";
    private const string DevStoreAccountKey = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

    private TestcontainersContainer? _azurite;

    private bool _dockerAvailable = true;

    public async Task InitializeAsync()
    {
        try
        {
            _azurite = new TestcontainersBuilder<TestcontainersContainer>()
                .WithImage("mcr.microsoft.com/azure-storage/azurite:3.33.0")
                .WithCommand("azurite-table --tableHost 0.0.0.0 --tablePort 10002")
                .WithPortBinding(10002, assignRandomHostPort: true)
                .WithWaitStrategy(Wait.ForUnixContainer().UntilPortIsAvailable(10002))
                .Build();

            await _azurite.StartAsync();
        }
        catch (Exception)
        {
            _dockerAvailable = false;
        }
    }

    public Task DisposeAsync() => _azurite is null ? Task.CompletedTask : _azurite.DisposeAsync().AsTask();

    [Fact]
    public async Task RootHealthEndpoint_ReturnsHealthy_WhenAzuriteTableIsConfigured()
    {
        if (!_dockerAvailable)
        {
            return;
        }

        var tablePort = _azurite!.GetMappedPublicPort(10002);
        var connectionString =
            $"DefaultEndpointsProtocol=http;AccountName={DevStoreAccountName};AccountKey={DevStoreAccountKey};TableEndpoint=http://127.0.0.1:{tablePort}/{DevStoreAccountName};";

        using var baseFactory = new TestWebApplicationFactory();
        using var factory = baseFactory.WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Development");
            builder.ConfigureAppConfiguration((_, cfg) =>
            {
                cfg.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["PoMiniGames:Storage:TableService:ConnectionString"] = connectionString,
                    ["PoMiniGames:Storage:TableService:TableName"] = "pominigames",
                });
            });
        });

        using var client = factory.CreateClient();
        var response = await client.GetAsync("/health");

        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var json = JsonNode.Parse(await response.Content.ReadAsStringAsync());
        json.Should().NotBeNull();

        var checks = json!["checks"]!.AsArray();
        var tableCheck = checks
            .Select(node => new
            {
                Name = node?["name"]?.GetValue<string>(),
                Status = node?["status"]?.GetValue<string>(),
            })
            .FirstOrDefault(node => string.Equals(node.Name, "AzureTableStorage", StringComparison.Ordinal));

        tableCheck.Should().NotBeNull();
        tableCheck!.Status.Should().Be("Healthy");
    }
}
