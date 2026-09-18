// filepath: src/PoMiniGames.API/AI/JevEndpoints.cs
using Microsoft.Extensions.Options;

namespace PoMiniGames.AI;

/// <summary>
/// <c>GET /api/health/jev</c> — runtime read-model of what Jev is thinking and the
/// impact its decisions are having on the host.
///
/// <para>
/// <b>Why a sibling to <c>/api/health/ai</c>, not a section of it.</b> The AI endpoint
/// reports counts for the chat-client pipeline (calls, tokens, latency, budget);
/// Jev is a different surface — typed primitives, no streaming, no token counts,
/// no chat budget — so its read-model has different fields (decision traces, gate
/// outcomes, bypass reasons). Keeping the endpoints separate means neither side
/// has to grow conditional shapes that the other does not need.
/// </para>
///
/// <para>
/// <b>What the response shows.</b> Per-game call counts, the question-type
/// distribution (noul / choice / score), the most-recent chosen options, the most
/// recent 50 decisions with their calibrated confidence, and the configured Jev
/// provider / model so you can tell at a glance whether the host is wired to
/// OpenRouter or to a stub.
/// </para>
/// </summary>
public static class JevEndpoints
{
    public static IEndpointRouteBuilder MapJevEndpoints(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/api/health/jev").WithTags("Health");

        group.MapGet("", GetUsage)
             .WithName("JevUsage")
             .WithSummary("Jev decision counts, gate outcomes, and recent decision traces.")
             .Produces<JevHealthDto>(StatusCodes.Status200OK);

        return routes;
    }

    private static IResult GetUsage(JevUsageAccumulator usage, IOptionsMonitor<JevOptions> options)
    {
        var opts = options.CurrentValue;
        var snapshot = usage.Snapshot();

        return Results.Ok(new JevHealthDto(
            Configured: opts.IsConfigured,
            Provider: opts.Provider,
            Endpoint: opts.IsConfigured ? opts.Endpoint : null,
            Model: opts.Model,
            DailyDecisionsPerIdentity: opts.DailyDecisionsPerIdentity,
            CallTimeoutMs: opts.CallTimeoutMs,
            Report: snapshot));
    }
}

public sealed record JevHealthDto(
    bool Configured,
    string Provider,
    string? Endpoint,
    string Model,
    int DailyDecisionsPerIdentity,
    int CallTimeoutMs,
    JevUsageReportDto Report);
