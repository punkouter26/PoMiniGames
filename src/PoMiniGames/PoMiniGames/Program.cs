using Azure.Identity;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.HealthChecks;
using PoMiniGames.Services;
using Scalar.AspNetCore;
using Serilog;
using Serilog.Sinks.ApplicationInsights.TelemetryConverters;

var builder = WebApplication.CreateBuilder(args);

// ─── Application Insights ─────────────────────────────────────────────
var appInsightsConnString = builder.Configuration["PoMiniGames:ApplicationInsights:ConnectionString"] 
    ?? builder.Configuration["APPINSIGHTS_CONNECTIONSTRING"];

if (!string.IsNullOrEmpty(appInsightsConnString))
{
    builder.Services.AddApplicationInsightsTelemetry(opts => 
    {
        opts.ConnectionString = appInsightsConnString;
    });
}

// ─── OpenTelemetry ───────────────────────────────────────────────────
builder.Services.AddOpenTelemetry().UseAzureMonitor();

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
        configuration
            .WriteTo.Console(outputTemplate:
                "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {NewLine}{Exception}");
    }
    else
    {
        var tc = services.GetService<Microsoft.ApplicationInsights.Extensibility.TelemetryConfiguration>();
        configuration
            .WriteTo.Console()
            .WriteTo.File(
                path: "logs/pomini-.log",
                rollingInterval: RollingInterval.Day,
                retainedFileCountLimit: 7);
        if (tc != null)
            configuration.WriteTo.ApplicationInsights(tc, TelemetryConverter.Traces);
    }
});

// ─── SQLite Storage ──────────────────────────────────────────────────
builder.Services.AddSingleton<StorageService>();

// ─── CORS ────────────────────────────────────────────────────────────
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        var origins = builder.Configuration
            .GetSection("Cors:AllowedOrigins").Get<string[]>()
            ?? ["http://localhost:5000", "http://localhost:5173"];
        policy.WithOrigins(origins).AllowAnyMethod().AllowAnyHeader().AllowCredentials();
    });
});

// ─── Health checks ───────────────────────────────────────────────────
builder.Services.AddHealthChecks()
    .AddCheck<StorageHealthCheck>("SqliteStorage");

// ─── Swagger / OpenAPI ───────────────────────────────────────────────
builder.Services.AddAuthorization();
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
app.UseAuthorization();

// ─── Minimal API endpoints (direct service calls) ────────────────────
app.MapHealthEndpoints();
app.MapDiagEndpoints();
app.MapGetPlayerStats();
app.MapSavePlayerStats();
app.MapGetLeaderboard();
app.MapGetAllPlayerStatistics();

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
