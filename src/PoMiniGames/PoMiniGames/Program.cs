using PoMiniGames.Features.PoRunner;   // GameOptions + SignalR session types (registered below)
using PoMiniGames.Features.PoSurvive;  // AddPoSurvive
using PoMiniGames.Features.Auth;       // Source-generated AuthLog + MicrosoftAuthOptionsBinder
using PoMiniGames.Application.Diagnostics;
using PoMiniGames.Infrastructure;
using PoMiniGames.Infrastructure.Services;
using Microsoft.Extensions.Options;
// Note: the full endpoint/hub route table is registered via app.MapPoMiniGamesEndpoints()
// (EndpointRouteExtensions); per-slice types there are referenced in that file, not here.
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
    // §2026-06-26 prod regression fix: MicrosoftAuthOptions.Enabled defaults to true
    // whenever ClientId + ApiClientId are present, even without an explicit Enabled=true
    // secret in KV. The post-configure binder only fires when Enabled is absent from
    // configuration; explicit true/false in KV or env var still wins.
    .AddOptions<PoMiniGames.Features.Auth.MicrosoftAuthOptions>()
    .Bind(builder.Configuration.GetSection(PoMiniGames.Features.Auth.MicrosoftAuthOptions.SectionName));

// Register the post-configure binder explicitly (it depends on IConfiguration).
builder.Services.AddSingleton<MicrosoftAuthOptionsBinder>();
builder.Services.AddSingleton<IPostConfigureOptions<PoMiniGames.Features.Auth.MicrosoftAuthOptions>>(
    sp => sp.GetRequiredService<MicrosoftAuthOptionsBinder>());
builder.Services.AddPoMiniGamesStorage(builder.Configuration)
    .AddPoMiniGamesAuth(builder.Environment, builder.Configuration)
    .AddPoMiniGamesGameServices()
    .AddPoMiniGamesRateLimiting()
    .AddPoSurvive(builder.Configuration);
builder.Services.AddSingleton<IDiagnosticsSnapshotProvider, ConfigurationDiagnosticsSnapshotProvider>();

// ─── PoRunner SignalR ────────────────────────────────────────────────
builder.Services.AddSignalR(options =>
{
    options.EnableDetailedErrors = true;
    // Server-side idle timeout + keep-alive. The earlier ~150s hang I observed
    // in the browser was the client WebSocket waiting for an idle close from
    // the server. These match SignalR's documented defaults for ASP.NET Core
    // 9 but pin them explicitly so the contract is grep-able.
    //   • KeepAlive: server pings the client every 30s
    //   • ClientTimeoutInterval: server tears the connection down after 60s
    //     without a pong. Clients should configure WithAutomaticReconnect().
    options.KeepAliveInterval = TimeSpan.FromSeconds(30);
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(60);
    // Per-message caps: the largest JSON we've seen in this app is the
    // PoMarbleRace leaderboard (~250KB). 256KB headroom keeps a single game
    // payload safe while still bounding the worst-case memory spike.
    options.MaximumReceiveMessageSize = 256 * 1024;
    options.StreamBufferCapacity = 32;
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

// Bug fix QA #10: gzip / brotli response compression for the Blazor WASM
// payload. Cold-start win is largest on the .native / .runtime / .js files
// (e.g. dotnet.native.*.js.gz drops 4 MB → 1.2 MB over the wire). The
// middleware is added below `UseHttpsRedirection`/exception handling so it
// runs as early as possible for the static WASM paths.
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<Microsoft.AspNetCore.ResponseCompression.BrotliCompressionProvider>();
    options.Providers.Add<Microsoft.AspNetCore.ResponseCompression.GzipCompressionProvider>();
    options.MimeTypes = Microsoft.AspNetCore.ResponseCompression.ResponseCompressionDefaults.MimeTypes.Concat(
    [
        // Application-specific MIME types: ensure the static WASM payload
        // is compressed on the wire. Without these, framework defaults
        // (which only include text/css, application/javascript, etc.) skip
        // application/wasm entirely.
        "application/wasm",
        "application/octet-stream",
        "application/json",
        "image/svg+xml",
    ]);
});
builder.Services.Configure<Microsoft.AspNetCore.ResponseCompression.BrotliCompressionProviderOptions>(o => o.Level = System.IO.Compression.CompressionLevel.Fastest);
builder.Services.Configure<Microsoft.AspNetCore.ResponseCompression.GzipCompressionProviderOptions>(o => o.Level = System.IO.Compression.CompressionLevel.Fastest);

var app = builder.Build();

// Production only: bind the singleton AzureBlobXmlRepository into the
// framework's KeyManagementOptions so DataProtection reads the same key-ring
// instance the rest of the app sees. Done here (post-Build) because we need
// the service provider to resolve the singleton; BuildServiceProvider from a
// raw IServiceCollection creates a duplicate container and is explicitly
// discouraged by Microsoft. Test/Dev skip this — they use the on-disk
// PersistKeysToFileSystem path configured inside AddPoMiniGamesDataProtection.
if (app.Environment.IsProduction())
{
    var xmlRepo = app.Services.GetRequiredService<AzureBlobXmlRepository>();
    app.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.DataProtection.KeyManagement.KeyManagementOptions>>()
        .Value.XmlRepository = xmlRepo;
}

// ─── Production safety guards ─────────────────────────────────────────
// All Production-fail-fast checks live in StartupSecretValidator (IHostedService
// that runs before the first HTTP request). Single source of truth — see
// src/PoMiniGames/PoMiniGames/Infrastructure/StartupSecretValidator.cs.

// Graceful degradation: warn loudly (but do not crash) when real OAuth is unconfigured.
var microsoftAuth = app.Services
    .GetRequiredService<Microsoft.Extensions.Options.IOptions<PoMiniGames.Features.Auth.MicrosoftAuthOptions>>().Value;
if (!microsoftAuth.Enabled)
{
    app.Logger.MicrosoftOAuthNotConfigured();
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
    app.Logger.StorageInitializerError(ex);
}

// ─── Exception handling & developer tooling ──────────────────────────
// Bug fix QA #10: response compression must be the FIRST middleware that
// touches the response body — any later middleware that calls `WriteAsync`
// or sets `Content-Length` directly will bypass it. Static files are
// streamed with `SendFile` (which honors the compression layer), so this
// ordering works for the WASM payload too.
app.UseResponseCompression();
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
// Bug fix QA #10: opt the static-files middleware into compression-aware
// responses by setting HttpsCompressionBehavior + adding Vary header. The
// static-files middleware uses `SendFile` when the response is unmodified,
// which bypasses compression; we force it through the response stream by
// removing the Content-Length and adding Vary: Accept-Encoding.
app.UseBlazorFrameworkFiles();

// ─── Security gate: refuse to serve appsettings.*.json over HTTP ───
// Why a middleware (not just a file filter): the Blazor static-file pipeline
// also resolves symlinks + content-root files. Returning 404 before the file
// system is read guarantees a config file is never on the wire, even if a
// future deploy puts a real secret into appsettings.Development.json.
// MUST be registered before UseStaticFiles so the gate fires before the
// static-files pipeline reads the file from disk.
app.Use(async (ctx, next) =>
{
    var p = ctx.Request.Path.Value;
    if (p is not null && p.StartsWith("/appsettings", StringComparison.OrdinalIgnoreCase) &&
        p.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
    {
        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return;
    }
    await next(ctx);
});

// Bug fix: the framework's published `_framework/Po*.pdb` debug symbols are
// not present in production builds, and their SRI hashes are baked into
// blazor.boot.json at publish time. Browsers block the failed fetches with
// "Failed to find a valid digest" console errors. Returning a 204 for any
// .pdb request keeps the boot.json happy without serving stale content.
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path.StartsWithSegments("/_framework") &&
        ctx.Request.Path.Value?.EndsWith(".pdb", StringComparison.OrdinalIgnoreCase) == true)
    {
        ctx.Response.StatusCode = StatusCodes.Status204NoContent;
        return;
    }
    await next(ctx);
});
app.UseStaticFiles(new Microsoft.AspNetCore.Builder.StaticFileOptions
{
    OnPrepareResponse = ctx =>
    {
        // Allow compression middleware to wrap the body.
        ctx.Context.Response.Headers["Vary"] = "Accept-Encoding";
        ctx.Context.Response.Headers.Remove("Content-Length");
        // Force streaming (not SendFile) so the compression layer can wrap the body.
        ctx.Context.Features.Set<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>(
            new Microsoft.AspNetCore.Http.StreamResponseBodyFeature(ctx.Context.Response.Body, ctx.Context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()!));
    }
});

app.UseAuthentication();
app.UseRateLimiter();
app.UseAuthorization();

// ─── Minimal API endpoints + SignalR hubs (one ordered registration) ──
// The whole route table lives in EndpointRouteExtensions.MapPoMiniGamesEndpoints.
app.MapPoMiniGamesEndpoints();

// ─── Fake /api/* fallback (§4 of QA report) ───────────────────────────
// The SPA fallback below (`MapFallbackToFile("index.html")`) intercepts every
// unmatched path and returns the Blazor shell. That is correct for client
// routes like /leaderboards, but it silently converts undefined /api/* paths
// (e.g. /api/face/sessions, /api/species, /api/couplequiz/game-history,
// /api/game/session) into a 200 OK with a 5019-byte HTML body, which clients
// may deserialise as data and corrupt state. The handler below short-circuits
// any /api/* path that fell through to a typed 404 JSON before the SPA
// fallback runs.
app.Map("/api/{*rest:nonfile}", () => Results.NotFound(new
{
    error = "no_such_endpoint",
    detail = "The requested /api/* path is not mapped. Check the OpenAPI document at /openapi/v1.json for the live route table."
}))
.ExcludeFromDescription(); // §7 of QA report: keep the catch-all out of the OpenAPI surface.

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
