using Serilog;
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
}
