using Microsoft.AspNetCore.RateLimiting;
using System.Threading.RateLimiting;

namespace PoMiniGames.Infrastructure;

/// <summary>Registers the rate-limiter policy used by high-score endpoints.</summary>
/// <remarks>
/// Pattern: Strategy + Specification. The limiter is parameterised by a partition key
/// (remote IP) and a fixed-window specification (10 requests / minute). Swapping the
/// window strategy (e.g. sliding-window or token-bucket) is a one-line change in the
/// <c>factory</c> delegate; the rest of the call sites are unaffected. This is the
/// textbook "rate-limiting as cross-cutting concern" decomposition from the
/// .NET rate-limiting middleware documentation.
/// </remarks>
internal static class RateLimitingExtensions
{
    public static IServiceCollection AddPoMiniGamesRateLimiting(this IServiceCollection services)
    {
        services.AddRateLimiter(opts =>
        {
            opts.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            opts.AddPolicy("highscores", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 10,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // PoSurvive: cloud inference relay (POST /api/infer) — 10 req/s per IP.
            opts.AddPolicy("infer", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromSeconds(1),
                        PermitLimit = 10,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));
        });

        return services;
    }
}
