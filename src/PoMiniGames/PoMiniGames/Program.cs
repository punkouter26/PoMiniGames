using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.HighScores;
using PoMiniGames.Features.PoRaceRagdoll;
using PoMiniGames.Features.PoRunner;
using PoMiniGames.Application.Diagnostics;
using PoMiniGames.Infrastructure;
using PoMiniGames.Infrastructure.Services;
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
builder.Services.AddSingleton<IDiagnosticsSnapshotProvider, ConfigurationDiagnosticsSnapshotProvider>();

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
app.UseMiddleware<RequestLogContextMiddleware>();
app.UsePoMiniGamesRequestLogging();
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

app.UseCors();

// ─── Blazor WASM hosting ─────────────────────────────────────────────
app.UseBlazorFrameworkFiles();
app.UseStaticFiles();

app.UseAuthentication();
app.UseRateLimiter();
app.UseAuthorization();

// ─── Minimal API endpoints (direct service calls) ────────────────────
app.MapAuthEndpoints();
app.MapHealthEndpoints();
app.MapDiagEndpoints();
app.MapTestHarnessEndpoints(app.Environment);
app.MapGetPlayerStats();
app.MapSavePlayerStats();
app.MapGetLeaderboard();
app.MapGetAllPlayerStatistics();
app.MapHighScoresEndpoints();
app.MapGameEndpoints();

// ─── PoRunner SignalR hub ────────────────────────────────────────────
app.MapHub<GameHub>("/porunner/gamehub");

// ─── SPA fallback ────────────────────────────────────────────────────
app.MapFallbackToFile("index.html");

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
