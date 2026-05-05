using Serilog;
using Serilog.Events;
using Serilog.Exceptions;
using Serilog.Sinks.ApplicationInsights.TelemetryConverters;

namespace PoMiniGames.Infrastructure;

/// <summary>Configures Serilog structured logging for all environments.</summary>
internal static class LoggingExtensions
{
    public static WebApplicationBuilder AddPoMiniGamesLogging(this WebApplicationBuilder builder)
    {
        builder.Host.UseSerilog((context, services, configuration) =>
        {
            configuration
                .ReadFrom.Configuration(context.Configuration)
                .ReadFrom.Services(services)
                .Enrich.FromLogContext()
                .Enrich.WithExceptionDetails()
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
                configuration.WriteTo.Console();

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

        return builder;
    }

    public static IApplicationBuilder UsePoMiniGamesRequestLogging(this IApplicationBuilder app)
    {
        return app.UseSerilogRequestLogging(options =>
        {
            options.GetLevel = (httpContext, elapsed, ex) =>
            {
                if (ex is not null || httpContext.Response.StatusCode >= 500)
                {
                    return LogEventLevel.Error;
                }

                return LogEventLevel.Information;
            };

            options.EnrichDiagnosticContext = (diagnosticsContext, httpContext) =>
            {
                var userId = httpContext.User?.Identity?.IsAuthenticated == true
                    ? httpContext.User.Identity?.Name
                    : "anonymous";
                var correlationId = httpContext.TraceIdentifier;
                var sessionId = httpContext.Items[RequestLogContextMiddleware.SessionItemKey]?.ToString() ?? "none";

                diagnosticsContext.Set("UserId", userId ?? "anonymous");
                diagnosticsContext.Set("CorrelationId", correlationId);
                diagnosticsContext.Set("SessionId", sessionId);
                diagnosticsContext.Set("Environment", app.ApplicationServices
                    .GetRequiredService<IHostEnvironment>()
                    .EnvironmentName);
                diagnosticsContext.Set("RequestPath", httpContext.Request.Path.Value ?? string.Empty);
                diagnosticsContext.Set("RequestMethod", httpContext.Request.Method);
                diagnosticsContext.Set("StatusCode", httpContext.Response.StatusCode);
            };
        });
    }
}
