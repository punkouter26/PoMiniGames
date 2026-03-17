using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;

namespace PoMiniGames.IntegrationTests;

/// <summary>
/// WebApplicationFactory that keeps the production auth pipeline intact while
/// running in Development so local dev-login endpoints can be tested.
/// </summary>
public class LocalAuthWebApplicationFactory : WebApplicationFactory<Program>
{
    private readonly string _tempDir = Path.Combine(Path.GetTempPath(), $"pomini-local-auth-test-{Guid.NewGuid()}");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.ConfigureAppConfiguration((_, cfg) =>
        {
            cfg.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Sqlite:DataDirectory"] = _tempDir,
            });
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && Directory.Exists(_tempDir))
        {
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(_tempDir, recursive: true); }
            catch { }
        }
    }
}
