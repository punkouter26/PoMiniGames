using Azure.Identity;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.IdentityModel.Tokens;
using System.Threading.RateLimiting;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.Lobby;
using PoMiniGames.Features.Multiplayer;
using PoMiniGames.Features.PoDropSquareHighScores;
using PoMiniGames.Features.PoRaceRagdoll;
using PoMiniGames.Features.SnakeHighScores;
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

builder.Services.AddAuthentication(options =>
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

            if (devLoginEnabled)
            {
                return AuthSchemes.DevCookie;
            }

            return JwtBearerDefaults.AuthenticationScheme;
        };
    })
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
builder.Services.AddSignalR();
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
builder.Services.AddAuthorization();
builder.Services.AddControllers();
builder.Services.AddOpenApi();

var app = builder.Build();

// ─── Global Exception Handler ────────────────────────────────────────
app.UseSerilogRequestLogging();
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler(errorApp =>
    {
        errorApp.Run(async context =>
        {
            context.Response.StatusCode = 500;
            context.Response.ContentType = "text/html";
            await context.Response.WriteAsync("<html><body><h1>An error occurred. Please try again later.</h1></body></html>");
        });
    });
    app.UseHsts();
}
else
{
    app.UseDeveloperExceptionPage();
}

app.MapOpenApi();
app.MapScalarApiReference(options =>
{
    options.Title = "PoMiniGames API";
    options.Theme = ScalarTheme.Purple;
});

app.UseCors();
app.UseStaticFiles();
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
app.MapGetPoDropSquareHighScores();
app.MapSavePoDropSquareHighScore();
app.MapGetSnakeHighScores();
app.MapSaveSnakeHighScore();
app.MapHub<MultiplayerHub>("/api/hubs/multiplayer").RequireAuthorization();
app.MapHub<LobbyHub>("/api/hubs/lobby").RequireAuthorization();

// ─── MVC Controllers (PoRaceRagdoll game API) ────────────────────────
app.MapControllers();

app.MapHealthChecks("/health");

// ─── SPA fallback (serves React build from wwwroot) ─────────────────
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
        // Don't strip the prefix, so it becomes PoMiniGames:Key in configuration
        return secret.Name.Replace("--", ConfigurationPath.KeyDelimiter);
    }
}
