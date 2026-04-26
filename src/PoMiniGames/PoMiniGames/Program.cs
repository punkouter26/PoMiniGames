using Microsoft.Extensions.FileProviders;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.HighScores;
using PoMiniGames.Features.PoRaceRagdoll;
using PoMiniGames.Features.PoRunner;
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

// ─── PoRunner SignalR ────────────────────────────────────────────────
builder.Services.AddSignalR(options =>
{
    options.EnableDetailedErrors = true;
}).AddJsonProtocol(options =>
{
    options.PayloadSerializerOptions.Converters.Add(
        new System.Text.Json.Serialization.JsonStringEnumConverter(
            System.Text.Json.JsonNamingPolicy.CamelCase));
});
builder.Services.Configure<GameOptions>(
    builder.Configuration.GetSection(GameOptions.SectionName));
builder.Services.AddSingleton<IGameSessionManager, GameSessionManager>();
builder.Services.AddHostedService(provider => (GameSessionManager)provider.GetRequiredService<IGameSessionManager>());

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
    app.Use(async (ctx, next) =>
    {
        var path = ctx.Request.Path.Value ?? "";
        if (ctx.Request.Path.StartsWithSegments("/assets"))
        {
            var fileName = System.IO.Path.GetFileName(path);
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
app.MapHighScoresEndpoints();
app.MapGameEndpoints();

app.MapHealthChecks("/health");

// ─── PoRunner SignalR hub ────────────────────────────────────────────
app.MapHub<GameHub>("/porunner/gamehub");

// ─── SPA fallback ────────────────────────────────────────────────────
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
        return secret.Name.Replace("--", ConfigurationPath.KeyDelimiter);
    }
}