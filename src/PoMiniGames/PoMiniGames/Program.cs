using Azure.Identity;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.FileProviders;
using Microsoft.IdentityModel.Tokens;
using System.Threading.RateLimiting;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.Lobby;
using PoMiniGames.Features.Multiplayer;
using PoMiniGames.Features.HighScores;
using PoMiniGames.Features.PoRaceRagdoll;
using PoMiniGames.HealthChecks;
using PoMiniGames.Services;
using Scalar.AspNetCore;
using Serilog;
using Serilog.Sinks.ApplicationInsights.TelemetryConverters;

var builder = WebApplication.CreateBuilder(args);

// ─── OpenTelemetry + Application Insights ───────────────────────────
var appInsightsConnString = builder.Configuration["PoMiniGames:ApplicationInsights:ConnectionString"]
    ?? builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"]
    ?? builder.Configuration["APPINSIGHTS_CONNECTIONSTRING"];

if (!string.IsNullOrEmpty(appInsightsConnString))
{
    builder.Services.AddOpenTelemetry().UseAzureMonitor(opts =>
    {
        opts.ConnectionString = appInsightsConnString;
    });
}

// ─── Azure Key Vault (cloud only) ────────────────────────────────────
var keyVaultUri = builder.Configuration["PoMiniGames:KeyVault:Uri"]
    ?? builder.Configuration["KeyVault:Uri"];

if (!string.IsNullOrEmpty(keyVaultUri))
{
    builder.Configuration.AddAzureKeyVault(
        new Uri(keyVaultUri),
        new DefaultAzureCredential(),
        new PrefixKeyVaultSecretManager("PoMiniGames"));
}

// ─── Simple Serilog configuration ─────────────────────────────────────
builder.Host.UseSerilog((context, services, configuration) =>
{
    configuration
        .ReadFrom.Configuration(context.Configuration)
        .ReadFrom.Services(services)
        .Enrich.FromLogContext()
        .Enrich.WithEnvironmentName()
        .Enrich.WithMachineName()
        .Enrich.WithThreadId()
        .Enrich.WithProperty("Application", "PoMiniGames");

    if (context.HostingEnvironment.IsDevelopment())
    {
        var logsPath = Path.Combine(context.HostingEnvironment.ContentRootPath, "logs");
        Directory.CreateDirectory(logsPath);

        configuration
            .WriteTo.File(
                Path.Combine(logsPath, "pominigames-.log"),
                rollingInterval: RollingInterval.Day,
                retainedFileCountLimit: 7,
                shared: true,
                flushToDiskInterval: TimeSpan.FromSeconds(1),
                outputTemplate:
                    "[{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} {Level:u3}] {Message:lj} {NewLine}{Exception}")
            .WriteTo.Console(outputTemplate:
                "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {NewLine}{Exception}");
    }
    else
    {
        configuration
            .WriteTo.Console();

        var aiCs = context.Configuration["PoMiniGames:ApplicationInsights:ConnectionString"]
            ?? context.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"]
            ?? context.Configuration["APPINSIGHTS_CONNECTIONSTRING"];
        if (!string.IsNullOrEmpty(aiCs))
        {
            var tc = new Microsoft.ApplicationInsights.Extensibility.TelemetryConfiguration
                { ConnectionString = aiCs };
            configuration.WriteTo.ApplicationInsights(tc, TelemetryConverter.Traces);
        }
    }
});

// ─── SQLite Storage ──────────────────────────────────────────────────
builder.Services.AddSingleton<StorageService>();
builder.Services.AddSingleton<IStorageService>(sp => sp.GetRequiredService<StorageService>());
builder.Services.AddHostedService<StorageServiceInitializer>();

// ─── Microsoft identity platform auth ────────────────────────────────
var microsoftAuthSection = builder.Configuration.GetSection(MicrosoftAuthOptions.SectionName);
builder.Services.Configure<MicrosoftAuthOptions>(microsoftAuthSection);
var microsoftAuthOptions = microsoftAuthSection.Get<MicrosoftAuthOptions>() ?? new MicrosoftAuthOptions();
var devLoginEnabled = builder.Environment.IsDevelopment();

// When DevBypass is enabled (Development only), every request is auto-authenticated
// as a local dev user — no explicit login step is required (mirrors Blazor's
// TestAuthStateProvider pattern).  The DevCookie / JWT schemes remain usable for
// calls that already carry credentials.
var devBypassEnabled = builder.Environment.IsDevelopment()
    && (builder.Configuration.GetValue<bool?>("PoMiniGames:DevBypassAuth") ?? true);

var authBuilder = builder.Services.AddAuthentication(options =>
    {
        options.DefaultAuthenticateScheme = AuthSchemes.Composite;
        options.DefaultChallengeScheme = AuthSchemes.Composite;
    })
    .AddPolicyScheme(AuthSchemes.Composite, AuthSchemes.Composite, options =>
    {
        options.ForwardDefaultSelector = context =>
        {
            var authHeader = context.Request.Headers.Authorization.ToString();
            if (!string.IsNullOrWhiteSpace(authHeader)
                && authHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            {
                return JwtBearerDefaults.AuthenticationScheme;
            }

            if (context.Request.Query.ContainsKey("access_token")
                && !string.IsNullOrWhiteSpace(context.Request.Query["access_token"]))
            {
                return JwtBearerDefaults.AuthenticationScheme;
            }

            // Developer bypass: prefer an existing DevCookie session (set by
            // POST /api/auth/dev-bypass?user=Name) so different browser tabs can
            // hold distinct identities.  Fall back to the auto-handler when no
            // cookie is present yet.
            if (devBypassEnabled)
            {
                return context.Request.Cookies.ContainsKey("PoMiniGames.DevAuth")
                    ? AuthSchemes.DevCookie
                    : AuthSchemes.DevBypass;
            }

            if (devLoginEnabled)
            {
                return AuthSchemes.DevCookie;
            }

            return JwtBearerDefaults.AuthenticationScheme;
        };
    });

// Register the bypass handler only in Development — never ships to production
if (devBypassEnabled)
{
    authBuilder.AddScheme<AuthenticationSchemeOptions, DevBypassAuthHandler>(AuthSchemes.DevBypass, _ => { });
}

authBuilder
    .AddCookie(AuthSchemes.DevCookie, options =>
    {
        options.Cookie.Name = "PoMiniGames.DevAuth";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Lax;
        options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        options.Events = new CookieAuthenticationEvents
        {
            OnRedirectToLogin = context =>
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return Task.CompletedTask;
            },
            OnRedirectToAccessDenied = context =>
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return Task.CompletedTask;
            },
        };
    })
    .AddJwtBearer(options =>
    {
        var authority = microsoftAuthOptions.Authority;
        var audience = microsoftAuthOptions.ApiClientId;

        options.MapInboundClaims = false;
        options.RequireHttpsMetadata = !builder.Environment.IsDevelopment();

        if (!string.IsNullOrWhiteSpace(authority))
        {
            options.Authority = authority;
        }

        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = false,
            ValidateAudience = !string.IsNullOrWhiteSpace(audience),
            ValidAudience = audience,
            NameClaimType = "name",
            RoleClaimType = "roles",
        };

        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                var accessToken = context.Request.Query["access_token"];
                var path = context.HttpContext.Request.Path;
                if (!string.IsNullOrWhiteSpace(accessToken) && path.StartsWithSegments("/api/hubs"))
                {
                    context.Token = accessToken;
                }

                return Task.CompletedTask;
            },
        };
    });

// ─── PoRaceRagdoll Services ──────────────────────────────────────────
builder.Services.AddSingleton<IOddsService, OddsService>();
builder.Services.AddSingleton<IRacerService, RacerService>();
builder.Services.AddSingleton<IGameSessionService, GameSessionService>();

// ─── Shared multiplayer platform ─────────────────────────────────────
builder.Services.AddSignalR().AddJsonProtocol(options =>
{
    options.PayloadSerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
});
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
});
builder.Services.AddSingleton<IMultiplayerGameRegistry, MultiplayerGameRegistry>();
builder.Services.AddSingleton<IMultiplayerService, MultiplayerService>();

// ─── Lobby ───────────────────────────────────────────────────────────
builder.Services.AddSingleton<ILobbyService, LobbyService>();

// ─── CORS ────────────────────────────────────────────────────────────
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        var origins = builder.Configuration
            .GetSection("PoMiniGames:Cors:AllowedOrigins").Get<string[]>()
            ?? builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
            ?? ["http://localhost:5000", "http://localhost:5173"];
        policy.WithOrigins(origins).AllowAnyMethod().AllowAnyHeader().AllowCredentials();
    });
});

// ─── Rate Limiting ───────────────────────────────────────────────────
builder.Services.AddRateLimiter(opts =>
{
    opts.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    opts.AddPolicy("highscores", ctx =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                Window            = TimeSpan.FromMinutes(1),
                PermitLimit       = 10,
                AutoReplenishment = true,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit        = 0,
            }));
});

// ─── Health checks ───────────────────────────────────────────────────
builder.Services.AddHealthChecks()
    .AddCheck<StorageHealthCheck>("SqliteStorage");

// ─── Swagger / OpenAPI ───────────────────────────────────────────────
builder.Services.AddProblemDetails();
builder.Services.AddAuthorization();
builder.Services.AddOpenApi();

var app = builder.Build();

// ─── Global Exception Handler ────────────────────────────────────────
app.UseSerilogRequestLogging();
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler();   // Returns RFC 9457 application/problem+json via IProblemDetailsService
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
