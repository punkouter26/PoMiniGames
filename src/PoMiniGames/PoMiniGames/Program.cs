using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.HighScores;
using PoMiniGames.Features.PoRaceRagdoll;
using PoMiniGames.Features.PoRunner;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Features.PoSurvive;
using PoMiniGames.Application.Diagnostics;
using PoMiniGames.Infrastructure;
using PoMiniGames.Infrastructure.Services;
// Note: PoCoupleQuiz types are referenced via fully-qualified names to avoid ambiguity
// with the identically-named IGameSessionManager in PoMiniGames.Features.PoRunner.
using Scalar.AspNetCore;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// ─── Telemetry & Key Vault ───────────────────────────────────────────
builder
    .AddPoMiniGamesTelemetry()
    .AddPoMiniGamesKeyVault()
    .AddPoMiniGamesLogging();

// ─── Data Protection (§2.2 encrypted cookies) ──────────────────────
// Pinned BEFORE auth so AddCookie picks up the configured IDataProtector.
var storageAccountName = builder.Configuration["PoMiniGames:Storage:TableService:AccountName"];
builder.Services.AddPoMiniGamesDataProtection(builder.Environment, storageAccountName);

// ─── Application services ────────────────────────────────────────────
builder.Services
    .Configure<PoMiniGames.Features.PoCoupleQuiz.CoupleQuizOptions>(
        builder.Configuration.GetSection(PoMiniGames.Features.PoCoupleQuiz.CoupleQuizOptions.SectionName))
    .AddPoMiniGamesStorage(builder.Configuration)
    .AddPoMiniGamesAuth(builder.Environment, builder.Configuration)
    .AddPoMiniGamesGameServices()
    .AddPoMiniGamesRateLimiting()
    .AddPoSurvive(builder.Configuration);
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
builder.Services.AddSingleton<IGameBroadcaster, SignalRGameBroadcaster>();
builder.Services.AddSingleton<IGameSessionManager, GameSessionManager>();
builder.Services.AddHostedService(provider => (GameSessionManager)provider.GetRequiredService<IGameSessionManager>());

// ─── Swagger / OpenAPI ───────────────────────────────────────────────
builder.Services.AddProblemDetails();
builder.Services.AddAuthorization();
builder.Services.AddOpenApi();

var app = builder.Build();

// ─── Production safety guards ─────────────────────────────────────────
// Hard guard: the fake auth scheme must NEVER be registered in Production.
if (app.Environment.IsProduction())
{
    var schemeProvider = app.Services.GetRequiredService<Microsoft.AspNetCore.Authentication.IAuthenticationSchemeProvider>();
    if (await schemeProvider.GetSchemeAsync(PoMiniGames.Features.Auth.FakeAuthHandler.SchemeName) is not null)
    {
        throw new InvalidOperationException(
            $"SECURITY: '{PoMiniGames.Features.Auth.FakeAuthHandler.SchemeName}' authentication scheme is registered in a Production environment. This is forbidden.");
    }
}

// Graceful degradation: warn loudly (but do not crash) when real OAuth is unconfigured.
var microsoftAuth = app.Services
    .GetRequiredService<Microsoft.Extensions.Options.IOptions<PoMiniGames.Features.Auth.MicrosoftAuthOptions>>().Value;
if (!microsoftAuth.Enabled)
{
    app.Logger.LogWarning(
        "Microsoft OAuth is NOT configured (missing ClientId/ApiClientId). The app will boot, but /api/auth/me will report OAuth as unconfigured and real sign-in is unavailable.");
}

// Initialize storage eagerly so the database is ready before the first request.
app.Services.GetRequiredService<StorageService>().Initialize();

// Ensure the additional tables and blob containers for the consolidated games
// (PoCoupleQuiz, PoFunQuiz, PoFace) exist. Runs idempotently; failures are logged
// but never block startup.
try
{
    await app.Services.GetRequiredService<StorageInitializer>().InitializeAsync();
}
catch (Exception ex)
{
    app.Logger.LogWarning(ex, "StorageInitializer reported an error; per-game tables/containers will be retried lazily on first use");
}

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
app.MapMarbleRaceHighScoresEndpoints();
app.MapGameEndpoints();

// ─── PoRunner SignalR hub ────────────────────────────────────────────
app.MapHub<GameHub>("/porunner/gamehub");

// ─── PoCoupleQuiz endpoints + hub (Phase 1) ──────────────────────────
PoMiniGames.Features.PoCoupleQuiz.CoupleQuizEndpoints.MapCoupleQuizEndpoints(app);
app.MapHub<PoMiniGames.Features.PoCoupleQuiz.CoupleQuizHub>("/couplequiz/hubs/game");

// ─── PoFunQuiz endpoints (Phase 2) ──────────────────────────────────
PoMiniGames.Features.PoFunQuiz.FunQuizEndpoints.MapFunQuizEndpoints(app);
app.MapHub<PoMiniGames.Features.PoFunQuiz.FunQuizHub>("/funquiz/gamehub");
// The full multiplayer hub (CreateGame / JoinGame / Lobby / etc.) ships as a follow-up;
// the Solo-mode HTTP path is the MVP for Phase 2.

// ─── PoFace endpoints (Phase 3) ─────────────────────────────────────
PoMiniGames.Features.PoFace.FaceEndpoints.MapFaceEndpoints(app);
// PoFace ships with HTTP-only endpoints in the consolidation MVP (no SignalR hub).
// JS interop (webcam capture), Google Vision hybrid mode, and blob-backed
// session recaps are follow-up work.

// ─── PoRacer SignalR lobby + scores ─────────────────────────────────
app.MapHub<PoRacerLobbyHub>("/poracer/lobby-hub");
app.MapPoRacerScoreEndpoints();

// ─── PoSurvive (agent survival simulation) ───────────────────────────
app.MapPoSurviveEndpoints(app.Configuration);

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
