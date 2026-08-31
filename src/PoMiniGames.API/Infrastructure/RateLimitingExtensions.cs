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

            // §9.2 chaos-engineering hardening: every policy now keys on a compound
            // (IP + identity) partition. The previous IP-only design let a single
            // attacker behind a corporate NAT — or a single AutoGuest browser on a
            // shared connection — saturate the bucket for every legitimate user
            // behind that NAT. The compound partition keeps anonymous bursts from
            // poisoning authenticated traffic and lets DevCookie / JWT identities
            // get their own bucket on top of an IP-level bucket for anon traffic.
            opts.AddPolicy("highscores", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 10,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // Anonymous leaderboard READS. Separate from "highscores" on both axes:
            // a read is cheaper than a write (one bounded partition query, no
            // read-modify-write), and sharing a bucket would let a page that reads a
            // board before submitting to it starve its own write. 60/min still caps an
            // unauthenticated flood at ~1 rps per partition, which is what an endpoint
            // carrying AllowAnonymous needs — dropping the group's auth gate removes the
            // only other thing standing between a caller and Table Storage on an F1 plan.
            opts.AddPolicy("leaderboard-read", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 60,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            opts.AddPolicy("infer", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromSeconds(1),
                        PermitLimit = 10,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            opts.AddPolicy("ai-generation", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 5,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));
        });

        return services;
    }

    /// <summary>
    /// Compound partition key: <c>{ip}|{identity-or-anon}</c>. The authenticated
    /// user id (oid / NameIdentifier claim) — or <c>anon</c> when absent — is
    /// appended to the remote IP, so two distinct identities sharing an IP get
    /// separate buckets. The cookie session id (resolved by the auth middleware)
    /// is used as a fallback identity for unauthenticated DevCookie requests.
    /// </summary>
    private static string BuildPartitionKey(HttpContext ctx)
    {
        var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var identity = ctx.User?.Identity?.IsAuthenticated == true
            ? (ctx.User.FindFirst("oid")?.Value
               ?? ctx.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
               ?? ctx.User.Identity.Name
               ?? "auth")
            : "anon";
        return $"{ip}|{identity}";
    }
}
