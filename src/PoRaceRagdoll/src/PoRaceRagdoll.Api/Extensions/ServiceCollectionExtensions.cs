using Azure.Data.Tables;
using Azure.Identity;
using Azure.Monitor.OpenTelemetry.Exporter;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using PoRaceRagdoll.Api.Services;
using Scalar.AspNetCore;

namespace PoRaceRagdoll.Api.Extensions;

public static class ServiceCollectionExtensions
{
    public static WebApplicationBuilder AddPoRaceRagdollServices(this WebApplicationBuilder builder)
    {
        // Key Vault
        var keyVaultUri = new Uri("https://kv-poshared.vault.azure.net/");
        builder.Configuration.AddAzureKeyVault(keyVaultUri, new DefaultAzureCredential());

        // Services
        builder.Services.AddSingleton<IOddsService, OddsService>();
        builder.Services.AddSingleton<IRacerService, RacerService>();
        builder.Services.AddSingleton<IGameSessionService, GameSessionService>();

        // Table Storage
        var tableStorageCs = builder.Configuration["PoRaceRagdoll-TableStorageConnectionString"]
            ?? builder.Configuration["TableStorageConnectionString"]
            ?? "UseDevelopmentStorage=true";
        builder.Services.AddSingleton(new TableServiceClient(tableStorageCs));

        // Controllers
        builder.Services.AddControllers();

        // OpenAPI
        builder.Services.AddOpenApi(options =>
        {
            options.AddDocumentTransformer((document, _, _) =>
            {
                document.Info.Title = "PoRaceRagdoll API";
                document.Info.Version = "v1";
                document.Info.Description = "API for the PoRaceRagdoll 3D Ragdoll Racing Betting Game";
                return Task.CompletedTask;
            });
        });

        // Health Checks
        builder.Services.AddHealthChecks()
            .AddCheck("self", () => Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckResult.Healthy())
            .AddCheck("keyvault", () =>
            {
                try
                {
                    _ = builder.Configuration["APPLICATIONINSIGHTS-CONNECTION-STRING"];
                    return Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckResult.Healthy("Key Vault accessible");
                }
                catch (Exception ex)
                {
                    return Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckResult.Unhealthy("Key Vault unreachable", ex);
                }
            }, tags: ["ready"])
            .AddCheck("tablestorage", () =>
            {
                try
                {
                    var client = new TableServiceClient(tableStorageCs);
                    client.GetProperties();
                    return Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckResult.Healthy("Table Storage accessible");
                }
                catch (Exception ex)
                {
                    return Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckResult.Unhealthy("Table Storage unreachable", ex);
                }
            }, tags: ["ready"]);

        // CORS
        builder.Services.AddCors(options =>
        {
            options.AddPolicy("AllowFrontend", policy =>
            {
                var origins = new List<string> { "http://localhost:3000", "https://localhost:3000", "http://localhost:3002", "https://localhost:3002" };
                var prodOrigin = builder.Configuration["AllowedOrigins"];
                if (!string.IsNullOrEmpty(prodOrigin))
                {
                    origins.AddRange(prodOrigin.Split(';', StringSplitOptions.RemoveEmptyEntries));
                }
                policy.WithOrigins(origins.ToArray())
                    .AllowAnyHeader()
                    .AllowAnyMethod()
                    .AllowCredentials();
            });
        });

        // OpenTelemetry
        var otelServiceName = "PoRaceRagdoll.Api";
        var otelResource = ResourceBuilder.CreateDefault()
            .AddService(serviceName: otelServiceName, serviceVersion: "1.0.0");

        builder.Services.AddOpenTelemetry()
            .ConfigureResource(r => r.AddService(otelServiceName))
            .WithTracing(tracing =>
            {
                tracing.AddAspNetCoreInstrumentation()
                    .AddHttpClientInstrumentation()
                    .AddSource(otelServiceName);

                var appInsightsCs = builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"];
                if (!string.IsNullOrEmpty(appInsightsCs))
                {
                    tracing.AddAzureMonitorTraceExporter(o => o.ConnectionString = appInsightsCs);
                }
                else
                {
                    tracing.AddOtlpExporter();
                }
            })
            .WithMetrics(metrics =>
            {
                metrics.AddAspNetCoreInstrumentation()
                    .AddHttpClientInstrumentation()
                    .AddRuntimeInstrumentation();

                var appInsightsCs = builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"];
                if (!string.IsNullOrEmpty(appInsightsCs))
                {
                    metrics.AddAzureMonitorMetricExporter(o => o.ConnectionString = appInsightsCs);
                }
                else
                {
                    metrics.AddOtlpExporter();
                }
            });

        builder.Logging.AddOpenTelemetry(logging =>
        {
            logging.SetResourceBuilder(otelResource);
            logging.IncludeFormattedMessage = true;
            logging.IncludeScopes = true;

            var appInsightsCs = builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"];
            if (!string.IsNullOrEmpty(appInsightsCs))
            {
                logging.AddAzureMonitorLogExporter(o => o.ConnectionString = appInsightsCs);
            }
            else
            {
                logging.AddOtlpExporter();
            }
        });

        return builder;
    }

    public static WebApplication ConfigurePoRaceRagdoll(this WebApplication app)
    {
        // Request logging
        app.Use(async (context, next) =>
        {
            var logger = context.RequestServices.GetRequiredService<ILogger<Program>>();
            var sw = System.Diagnostics.Stopwatch.StartNew();
            logger.LogInformation("Request {Method} {Path} started", context.Request.Method, context.Request.Path);

            try
            {
                await next();
            }
            finally
            {
                sw.Stop();
                logger.LogInformation(
                    "Request {Method} {Path} completed with {StatusCode} in {ElapsedMs}ms",
                    context.Request.Method, context.Request.Path, context.Response.StatusCode, sw.ElapsedMilliseconds);
            }
        });

        // OpenAPI + Scalar
        if (app.Environment.IsDevelopment())
        {
            app.MapOpenApi();
            app.MapScalarApiReference(options =>
            {
                options.WithTitle("PoRaceRagdoll API")
                    .WithTheme(ScalarTheme.BluePlanet);
            });
        }

        // CORS
        app.UseCors("AllowFrontend");

        // Routing
        app.MapControllers();

        return app;
    }
}
