using PoDropSquare.Api.Extensions;
using PoDropSquare.Api.Middleware;
using PoDropSquare.Data.Repositories;

/*
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ PoDropSquare API (BFF)                                                     │
 * │ Run: dotnet run --project src/PoDropSquare.Api                             │
 * └─────────────────────────────────────────────────────────────────────────────┘
 * 
 * For KQL monitoring queries, see: /docs/KQL-QUERIES.md
 */

var builder = WebApplication.CreateBuilder(args);

// ============================================
// Health Checks
// ============================================
builder.Services.AddHealthCheckServices();

// ============================================
// Service Configuration
// ============================================

// Add application services (business logic)
builder.Services.AddApplicationServices();

// Add built-in rate limiting (.NET 10)
builder.Services.AddRateLimitingServices(builder.Configuration);

// Add RFC 7807 ProblemDetails support
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = context =>
    {
        context.ProblemDetails.Extensions["traceId"] = context.HttpContext.TraceIdentifier;
        context.ProblemDetails.Extensions["instance"] = context.HttpContext.Request.Path.Value;
    };
});

// Add data repositories (Azure Table Storage)
var tableStorageConnectionString = builder.Configuration.GetConnectionString("AzureTableStorage")
    ?? "UseDevelopmentStorage=true";
builder.Services.AddDataRepositories(tableStorageConnectionString);

// Add ASP.NET Core services
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();

builder.Services.AddCors(options =>
{
    options.AddPolicy("DevCors", policy =>
    {
        policy
            .WithOrigins("http://localhost:5173", "https://localhost:5173", "http://localhost:5010", "https://localhost:5010")
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

// Use native .NET 10 OpenAPI instead of Swashbuckle
builder.Services.AddOpenApi();

// Add response caching (required for VaryByQueryKeys in ResponseCache attribute)
builder.Services.AddResponseCaching();

var app = builder.Build();

// Initialize repositories (ensure tables exist)
using (var scope = app.Services.CreateScope())
{
    var scoreRepository = scope.ServiceProvider.GetRequiredService<IScoreRepository>();
    var leaderboardRepository = scope.ServiceProvider.GetRequiredService<ILeaderboardRepository>();

    if (scoreRepository is ScoreRepository scoreRepo)
    {
        await scoreRepo.InitializeAsync();
    }

    if (leaderboardRepository is LeaderboardRepository leaderboardRepo)
    {
        await leaderboardRepo.InitializeAsync();
    }
}

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    // Native .NET 10 OpenAPI endpoint
    app.MapOpenApi();
}

// Add global error handling middleware (must be early in pipeline)
app.UseMiddleware<ErrorHandlingMiddleware>();

app.UseHttpsRedirection();

// Add built-in rate limiting middleware
app.UseRateLimiter();

// Add response caching middleware (must be before UseStaticFiles and controllers)
app.UseResponseCaching();

// Configure static files for Blazor WASM
app.UseBlazorFrameworkFiles();
app.UseStaticFiles();

app.UseRouting();

if (app.Environment.IsDevelopment())
{
    app.UseCors("DevCors");
}

app.MapControllers();

// Health check via controller (HealthController handles /health and /api/health)
// Keep /alive for liveness probe only
app.MapHealthChecks("/alive", new Microsoft.AspNetCore.Diagnostics.HealthChecks.HealthCheckOptions
{
    Predicate = r => r.Tags.Contains("live")
});

// Fallback route for Blazor WASM client-side routing
app.MapFallbackToFile("index.html");

app.Run();

// Make Program class accessible to tests
public partial class Program { }
