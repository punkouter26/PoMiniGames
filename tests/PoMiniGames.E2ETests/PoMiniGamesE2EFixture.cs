using Azure.Data.Tables;
using Azure.Storage.Blobs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace PoMiniGames.E2ETests;

/// <summary>
/// Spins the real host in-process via <see cref="WebApplicationFactory{TEntryPoint}"/>
/// so the e2e tests exercise the full ASP.NET Core pipeline (auth, routing,
/// middleware, BFF-static-file serving) without requiring a separate Vite/Node
/// process.
/// </summary>
/// <remarks>
/// <para>
/// Pattern: Test Fixture (xUnit). The fixture provides a configured
/// <see cref="WebApplicationFactory{TEntryPoint}"/> whose lifetime is the
/// xUnit collection lifetime; tests that opt in share the in-memory server.
/// </para>
/// <para>
/// The fixture assumes Azurite Table Storage is reachable on
/// <c>127.0.0.1:10002</c> with the well-known dev account
/// (<c>devstoreaccount1</c> + canned key). <c>scripts/setup.ps1</c> brings
/// that container up via docker-compose. CI must do the same before running
/// this test project.
/// </para>
/// </remarks>
public sealed class PoMiniGamesE2EFixture : WebApplicationFactory<Program>
{
    public const string AzuriteConnectionString =
        "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
        "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
        "TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;" +
        "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");

        // §2.3: enable the header-driven fake-auth scheme so e2e tests can
        // assert identity variations without performing a real OAuth handshake.
        // AddPoMiniGamesAuth() reads Auth:EnableFakeAuth at registration time,
        // so the override MUST land in host configuration (which runs before
        // service registration), not in app configuration.
        builder.ConfigureAppConfiguration((_, cfg) =>
        {
            cfg.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Auth:EnableFakeAuth"] = "true",
                ["PoMiniGames:Storage:TableService:ConnectionString"] = AzuriteConnectionString,
                ["PoMiniGames:Storage:TableService:TableName"] = "pominigames-e2e",
            });
        });

        builder.ConfigureTestServices(services =>
        {
            // The host's per-game repositories constructor-inject Azure SDK
            // clients; those clients are not registered elsewhere. Provide them
            // here from the same Azurite connection string the host already uses.
            services.AddSingleton(_ => new TableServiceClient(AzuriteConnectionString));
            services.AddSingleton(_ => new BlobServiceClient(AzuriteConnectionString));

            // The canonical harness for header-driven FakeAuth identity is
            // TestWebApplicationFactory in the integration-test project. The e2e
            // suite is intentionally lighter — it asserts the BFF contract
            // (HTTP routes / status codes / JSON shape), not the auth pipeline.
        });
    }
}

[CollectionDefinition(Name)]
public sealed class PoMiniGamesE2ECollection : ICollectionFixture<PoMiniGamesE2EFixture>
{
    public const string Name = "PoMiniGames.E2E";
}
