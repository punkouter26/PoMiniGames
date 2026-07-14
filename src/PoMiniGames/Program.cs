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

// ─── Static web assets in Test ───────────────────────────────────────
// ASP.NET auto-loads the static-web-assets manifest (which maps the referenced
// Blazor Client's index.html/_framework into the served file set) ONLY in the
// Development environment. The E2E-UI tier boots the host under "Test", where
// UseBlazorFrameworkFiles/MapFallbackToFile would otherwise 404 on every page.
if (builder.Environment.IsEnvironment("Test"))
{
    builder.WebHost.UseStaticWebAssets();
}

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

// ─── SignalR (shared by all multiplayer hubs) ─────────────────────────────────
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
// (PoCoupleQuiz, PoFunQuiz) exist. Runs idempotently; failures are logged
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

// ─── Dev-only: never cache the boot chain ────────────────────────────
// The SPA shell (index.html, served for extensionless routes), /_framework/*,
// and the non-fingerprinted .css/.js are how the browser discovers the current
// fingerprinted asset names. If they sit in the HTTP cache, a rebuild changes
// the fingerprints and an already-open tab keeps requesting the old (now 404)
// files → "An unhandled error has occurred" on load. In Development we force
// revalidation so a plain reload always lands on the freshest build. Production
// keeps normal caching (fingerprinted assets are immutable and safe to cache).
if (app.Environment.IsDevelopment())
{
    app.Use(async (ctx, next) =>
    {
        var path = ctx.Request.Path.Value ?? "/";
        var noCache = path.StartsWith("/_framework", StringComparison.OrdinalIgnoreCase)
            || !System.IO.Path.HasExtension(path)                       // SPA shell routes ("/", "/connectfive/1")
            || path.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".js", StringComparison.OrdinalIgnoreCase);
        if (noCache)
        {
            ctx.Response.OnStarting(() =>
            {
                ctx.Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
                return Task.CompletedTask;
            });
        }
        await next();
    });
}

// ─── Blazor WASM hosting ─────────────────────────────────────────────
// Bug fix QA #10: opt the static-files middleware into compression-aware
// responses by setting HttpsCompressionBehavior + adding Vary header. The
// static-files middleware uses `SendFile` when the response is unmodified,
// which bypasses compression; we force it through the response stream by
// removing the Content-Length and adding Vary: Accept-Encoding.
app.UseBlazorFrameworkFiles();

// ─── Security gate: serve the *client's* appsettings.*.json, not the server's ───
// Why this exists: the Blazor WASM runtime fetches /appsettings.json at startup
// and treats a 404 as a fatal init error (MONO_WASM: download 'http://...
// appsettings.json' ... failed 404). We therefore intercept the request and
// serve ONLY the client's appsettings (PoSurvive model list, public API base
// address) — the server's appsettings (Key Vault endpoints, secrets, AAD
// client ids) are never returned to a browser.
//
// MUST be registered before UseStaticFiles so the gate fires before the
// static-files pipeline reads the file from disk.
app.Use(async (ctx, next) =>
{
    var p = ctx.Request.Path.Value;
    if (p is not null && p.StartsWith("/appsettings", StringComparison.OrdinalIgnoreCase) &&
        p.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
    {
        // Restrict to a small allowlist of filenames; block any other path that
        // somehow resolves under appsettings*.json (e.g. ../ traversal).
        var fileName = p.TrimStart('/');
        if (fileName.Contains('/') || fileName.Contains('\\') ||
            !(fileName.Equals("appsettings.json", StringComparison.OrdinalIgnoreCase) ||
              fileName.Equals("appsettings.Development.json", StringComparison.OrdinalIgnoreCase)))
        {
            ctx.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        // Resolve the *client's* appsettings file from disk. PoMiniGames.csproj's
        // StageBlazorClientStaticWebAssets target copies the client's
        // appsettings files into <bin>/wwwroot/appsettings*.json. We deliberately
        // do NOT serve ContentRootPath or AppContext.BaseDirectory, because those
        // contain the server's own appsettings.json (Key Vault URIs, AAD client
        // ids, secrets) and exposing them to a browser would leak configuration.
        var env = ctx.RequestServices.GetRequiredService<IWebHostEnvironment>();
        var fullPath = (string?)null;
        var wwwrootRoot = env.WebRootPath;
        if (string.IsNullOrEmpty(wwwrootRoot))
        {
            // Fall back: in `dotnet run` WebRootPath may be the source project root
            // (where no wwwroot/ exists), so look under bin/wwwroot instead.
            wwwrootRoot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        }
        var candidate = Path.Combine(wwwrootRoot, fileName);
        if (System.IO.File.Exists(candidate)) fullPath = candidate;
        if (!System.IO.File.Exists(fullPath))
        {
            // Fall back to an empty payload so the Blazor WASM runtime still
            // boots — never 404 the client config, that bricks the SPA.
            ctx.Response.StatusCode = StatusCodes.Status200OK;
            ctx.Response.ContentType = "application/json";
            ctx.Response.Headers["Cache-Control"] = "no-store";
            await ctx.Response.WriteAsync("{}");
            return;
        }

        ctx.Response.StatusCode = StatusCodes.Status200OK;
        ctx.Response.ContentType = "application/json";
        ctx.Response.Headers["Cache-Control"] = "no-store";
        await ctx.Response.SendFileAsync(fullPath);
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
