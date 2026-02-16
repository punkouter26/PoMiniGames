using Azure.Data.Tables;
using Azure.Identity;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.HealthChecks;
using PoMiniGames.Services;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// ─── Azure Key Vault (cloud only) ────────────────────────────────────
var keyVaultUri = builder.Configuration["KeyVault:Uri"];
if (!string.IsNullOrEmpty(keyVaultUri))
{
    builder.Configuration.AddAzureKeyVault(
        new Uri(keyVaultUri),
        new DefaultAzureCredential(),
        new PrefixKeyVaultSecretManager("PoMiniGames"));
}

// ─── Simple Serilog configuration ─────────────────────────────────────
builder.Host.UseSerilog((context, configuration) =>
{
    configuration
        .ReadFrom.Configuration(context.Configuration)
        .Enrich.FromLogContext()
        .Enrich.WithEnvironmentName();

    if (context.HostingEnvironment.IsDevelopment())
    {
        configuration
            .WriteTo.Console(outputTemplate:
                "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {NewLine}{Exception}");
    }
    else
    {
        configuration
            .WriteTo.Console()
            .WriteTo.File(
                path: "logs/pomini-.log",
                rollingInterval: RollingInterval.Day,
                retainedFileCountLimit: 7);
    }
});

// ─── Azure Table Storage ─────────────────────────────────────────────
var storageAccountName = builder.Configuration["PoMiniGames:StorageAccountName"] 
    ?? builder.Configuration["AZURE_STORAGE_ACCOUNT_NAME"];

TableServiceClient tableServiceClient;

// Prefer Connection String if provided (v2 deployment passes it)
var connectionString = builder.Configuration.GetConnectionString("Tables")
    ?? builder.Configuration["ConnectionStrings:AzureTableStorage"];

if (!string.IsNullOrEmpty(connectionString))
{
    tableServiceClient = new TableServiceClient(connectionString);
}
else if (!string.IsNullOrEmpty(storageAccountName))
{
    var tableUri = new Uri($"https://{storageAccountName}.table.{builder.Configuration["Azure:EndpointSuffix"] ?? "core.windows.net"}");
    tableServiceClient = new TableServiceClient(tableUri, new DefaultAzureCredential());
}
else
{
    tableServiceClient = new TableServiceClient("UseDevelopmentStorage=true");
}

builder.Services.AddSingleton(tableServiceClient);
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
    .AddCheck<StorageHealthCheck>("AzureTableStorage");

// ─── Swagger / OpenAPI ───────────────────────────────────────────────
builder.Services.AddAuthorization();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

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

app.UseSwagger();
app.UseSwaggerUI(o =>
{
    o.SwaggerEndpoint("/swagger/v1/swagger.json", "PoMiniGames API v1");
});

app.UseCors();
app.UseStaticFiles();
app.UseAuthorization();

// ─── Minimal API endpoints (direct service calls) ────────────────────
app.MapHealthEndpoints();
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
        return secret.Name.Substring(_prefix.Length).Replace("--", ConfigurationPath.KeyDelimiter);
    }
}
