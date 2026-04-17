using Microsoft.Extensions.FileProviders;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.Lobby;
using PoMiniGames.Features.Multiplayer;
using PoMiniGames.Features.HighScores;
using PoMiniGames.Features.PoRaceRagdoll;
using PoMiniGames.Infrastructure;
using PoMiniGames.Services;
using Scalar.AspNetCore;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// ─── Telemetry & Key Vault ───────────────────────────────────────────
builder
    .AddPoMiniGamesTelemetry()
    .AddPoMiniGamesKeyVault()
    .AddPoMiniGamesLogging();

// ─── Application services ────────────────────────────────────────────
builder.Services
    .AddPoMiniGamesStorage()
    .AddPoMiniGamesAuth(builder.Environment, builder.Configuration)
    .AddPoMiniGamesGameServices()
    .AddPoMiniGamesCors(builder.Configuration)
    .AddPoMiniGamesRateLimiting();

// ─── Swagger / OpenAPI ───────────────────────────────────────────────
builder.Services.AddProblemDetails();
builder.Services.AddAuthorization();
builder.Services.AddOpenApi();

var app = builder.Build();

// Initialize storage eagerly so the database is ready before the first request.
app.Services.GetRequiredService<StorageService>().Initialize();

// ─── Exception handling & developer tooling ──────────────────────────
app.UseSerilogRequestLogging();
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler();
    app.UseHsts();
}
else
{
    // Swallow BadHttpRequestException (e.g. invalid request headers from scanners) silently in dev
    // so Serilog doesn't flood the output with ERROR-level stack traces.
    app.Use(async (ctx, next) =>
    {
        try { await next(ctx); }
        catch (Microsoft.AspNetCore.Http.BadHttpRequestException ex)
        {
            if (!ctx.Response.HasStarted)
            {
                ctx.Response.StatusCode = ex.StatusCode;
            }
        }
    });
    app.UseDeveloperExceptionPage();
}

app.MapOpenApi();
app.MapScalarApiReference(options =>
{
    options.Title = "PoMiniGames API";
    options.Theme = ScalarTheme.Purple;
});

var spaDistPath = Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "..", "..", "PoMiniGames.Client", "dist"));
var hasSpaDist = Directory.Exists(spaDistPath);
PhysicalFileProvider? spaDistProvider = hasSpaDist ? new PhysicalFileProvider(spaDistPath) : null;

if (hasSpaDist)
{
    Log.Information("Serving SPA assets from {SpaDistPath}", spaDistPath);

    // Warn if the dist may be stale (any .ts/.tsx source file is newer than dist/index.html).
    var distIndex = new FileInfo(Path.Combine(spaDistPath, "index.html"));
    if (distIndex.Exists)
    {
        var srcRoot = Path.Combine(spaDistPath, "..", "..", "src");
        var newestSrc = Directory.Exists(srcRoot)
            ? new DirectoryInfo(Path.GetFullPath(srcRoot))
                .EnumerateFiles("*.ts", SearchOption.AllDirectories)
                .Concat(new DirectoryInfo(Path.GetFullPath(srcRoot)).EnumerateFiles("*.tsx", SearchOption.AllDirectories))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .FirstOrDefault()
            : null;
        if (newestSrc is not null && newestSrc.LastWriteTimeUtc > distIndex.LastWriteTimeUtc)
        {
            Log.Warning("SPA dist may be stale: {Src} (modified {SrcTime}) is newer than dist/index.html ({DistTime}). Run 'npm run build'.",
                newestSrc.Name, newestSrc.LastWriteTimeUtc, distIndex.LastWriteTimeUtc);
        }
    }
}
else
{
    Log.Warning("SPA dist directory not found at {SpaDistPath}; serving default wwwroot assets", spaDistPath);
}

app.UseCors();

if (spaDistProvider is not null)
{
    // Cache-Control strategy:
    // - Entry-point bundles (main-*.js, popup-*.js): no-store, because Vite finalises
    //   the __vite__mapDeps chunk map AFTER computing the file hash, so the same hash
    //   can appear with different lazy-chunk references across builds.  Caching these
    //   as "immutable" causes the browser to serve a stale bundle that points to lazy
    //   chunks that no longer exist in the new build.
    // - All other /assets/* files (lazy chunks, CSS, images): immutable — Vite's
    //   content-hash guarantees they never change for a given URL.
    // - HTML and navigation paths: no-store so the browser always fetches the latest
    //   index.html with correct asset references.
    app.Use(async (ctx, next) =>
    {
        var path = ctx.Request.Path.Value ?? "";
        if (ctx.Request.Path.StartsWithSegments("/assets"))
        {
            var fileName = System.IO.Path.GetFileName(path);
            // Entry bundles share the "main-" or "popup-" prefix; treat them as mutable.
            var isEntryBundle = (fileName.StartsWith("main-", StringComparison.OrdinalIgnoreCase)
                              || fileName.StartsWith("popup-", StringComparison.OrdinalIgnoreCase))
                             && fileName.EndsWith(".js", StringComparison.OrdinalIgnoreCase);
            ctx.Response.Headers.CacheControl = isEntryBundle
                ? "no-store"
                : "public, max-age=31536000, immutable";
        }
        else if (!path.Contains('.') || path.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
        {
            ctx.Response.Headers.CacheControl = "no-store";
        }
        await next(ctx);
    });
    app.UseDefaultFiles(new DefaultFilesOptions
    {
        FileProvider = spaDistProvider,
    });

    app.UseStaticFiles(new StaticFileOptions
    {
        FileProvider = spaDistProvider,
    });
}
else
{
    app.UseStaticFiles();
}

app.UseAuthentication();
app.UseRateLimiter();
app.UseAuthorization();

// ─── Minimal API endpoints (direct service calls) ────────────────────
app.MapAuthEndpoints();
app.MapHealthEndpoints();
app.MapDiagEndpoints();
app.MapGetPlayerStats();
app.MapSavePlayerStats();
app.MapGetLeaderboard();
app.MapGetAllPlayerStatistics();
app.MapMultiplayerEndpoints();
app.MapLobbyEndpoints();
app.MapHighScoresEndpoints();
app.MapGameEndpoints();
app.MapHub<MultiplayerHub>("/api/hubs/multiplayer").RequireAuthorization();
app.MapHub<LobbyHub>("/api/hubs/lobby").RequireAuthorization();

app.MapHealthChecks("/health");

// ─── SPA fallback (serves React build from wwwroot) ─────────────────
if (spaDistProvider is not null)
{
    app.MapFallbackToFile("index.html", new StaticFileOptions
    {
        FileProvider = spaDistProvider,
    });
}
else
{
    app.MapFallbackToFile("index.html");
}

try
{
    Log.Information("Starting PoMiniGames on port 5000");
    app.Run();
}
catch (Exception ex)
{
    Log.Fatal(ex, "PoMiniGames terminated unexpectedly");
}
finally
{
    Log.CloseAndFlush();
}

/// <summary>Partial class anchor for WebApplicationFactory in tests.</summary>
public partial class Program { }

public class PrefixKeyVaultSecretManager : Azure.Extensions.AspNetCore.Configuration.Secrets.KeyVaultSecretManager
{
    private readonly string _prefix;
    public PrefixKeyVaultSecretManager(string prefix) => _prefix = $"{prefix}--";

    public override bool Load(Azure.Security.KeyVault.Secrets.SecretProperties properties) => properties.Name.StartsWith(_prefix, StringComparison.OrdinalIgnoreCase);

    public override string GetKey(Azure.Security.KeyVault.Secrets.KeyVaultSecret secret)
    {
        // Don't strip the prefix, so it becomes PoMiniGames:Key in configuration
        return secret.Name.Replace("--", ConfigurationPath.KeyDelimiter);
    }
}
