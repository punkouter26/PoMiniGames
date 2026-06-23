using Azure.Data.Tables;
using Azure.Storage.Blobs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace PoMiniGames.E2EUI;

/// <summary>
/// Boots the real host on a live Kestrel port so Playwright can drive it over
/// HTTP. <see cref="WebApplicationFactory{TEntryPoint}"/>'s default TestServer is
/// in-memory (no socket), which a real browser cannot reach — so this fixture
/// uses the documented dual-host trick: it builds the in-memory test host the
/// base class expects, then builds and starts a second Kestrel host and exposes
/// its bound address via <see cref="ServerAddress"/>.
/// </summary>
/// <remarks>
/// <para>Pattern: Test Fixture (xUnit) + Server Façade. Mirrors the Azurite /
/// FakeAuth configuration of the E2E-API fixture so the rendered app talks to
/// the same dev storage. Requires Azurite reachable on <c>127.0.0.1:10002</c>
/// and Playwright browsers installed (<c>pwsh bin/Debug/net10.0/playwright.ps1
/// install</c>). See README.md.</para>
/// </remarks>
public sealed class KestrelServerFixture : WebApplicationFactory<Program>
{
    public const string AzuriteConnectionString =
        "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
        "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
        "TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;" +
        "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

    private IHost? _kestrelHost;

    /// <summary>The base URL Playwright should navigate to (e.g. http://127.0.0.1:51234).</summary>
    public string ServerAddress
    {
        get
        {
            EnsureServer();
            return ClientOptions.BaseAddress.ToString();
        }
    }

    private void EnsureServer()
    {
        if (_kestrelHost is null)
            _ = Server; // forces CreateHost() below
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");

        builder.ConfigureAppConfiguration((_, cfg) =>
        {
            cfg.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Auth:EnableFakeAuth"] = "true",
                ["PoMiniGames:Storage:TableService:ConnectionString"] = AzuriteConnectionString,
                ["PoMiniGames:Storage:TableService:TableName"] = "pominigames-e2eui",
            });
        });

        builder.ConfigureTestServices(services =>
        {
            services.AddSingleton(_ => new TableServiceClient(AzuriteConnectionString));
            services.AddSingleton(_ => new BlobServiceClient(AzuriteConnectionString));
        });
    }

    protected override IHost CreateHost(IHostBuilder builder)
    {
        // The in-memory host the base class wires up (kept so DI/seed still runs).
        var testHost = builder.Build();

        // A second host bound to a real (dynamic) Kestrel port for the browser.
        builder.ConfigureWebHost(webHostBuilder => webHostBuilder.UseKestrel());
        _kestrelHost = builder.Build();
        _kestrelHost.Start();

        var addresses = _kestrelHost.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!;
        ClientOptions.BaseAddress = new Uri(addresses.Addresses.First());

        testHost.Start();
        return testHost;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing)
            _kestrelHost?.Dispose();
    }
}

[CollectionDefinition(Name)]
public sealed class KestrelServerCollection : ICollectionFixture<KestrelServerFixture>
{
    public const string Name = "PoMiniGames.E2EUI";
}
