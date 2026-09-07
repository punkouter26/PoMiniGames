using Serilog;
using Serilog.Sinks.ApplicationInsights.TelemetryConverters;
using Serilog.Events;
using Serilog.Exceptions;

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
                // Console for container stdout capture.
                configuration.WriteTo.Console();
            }

            // App Insights log export now matches every other Po app: the Serilog sink owns it.
            // The OTel pipeline keeps traces/metrics/dependencies; logs deliberately do NOT ride it,
            // which is why writeToProviders is back to its default of false — with both paths live,
            // every record would be ingested twice.
            var appInsightsConnectionString =
                PoPlatform.ResolveAppInsightsConnectionString(context.Configuration);
            configuration.WriteTo.Conditional(
                _ => !string.IsNullOrWhiteSpace(appInsightsConnectionString),
                sink => sink.ApplicationInsights(appInsightsConnectionString!, TelemetryConverter.Traces));
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
