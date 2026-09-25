using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.PoJevArena.Jev;
using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGames.Features.PoJevArena;

/// <summary>
/// The PoJevArena server surface. Mapped on the authenticated <c>/api</c> group
/// (EndpointRouteExtensions), so every route is signed-in only (guests included) and every write
/// is inside the antiforgery scope. The browser owns physics and the Black Box; the server owns
/// only what must not be forged cheaply: the Jev key, the prompt text, the daily allowance, the
/// match rosters and the result gate.
/// </summary>
public static class PoJevArenaEndpoints
{
    /// <summary>Largest decision batch: 20 units in 4 staggered slots is 5; 8 leaves slack.</summary>
    public const int MaxBatch = 8;

    private static readonly Meter Meter = new("PoMiniGames.PoJevArena");
    private static readonly Counter<long> JevCalls = Meter.CreateCounter<long>("pojevarena.jev.calls");
    private static readonly Counter<long> JevFailures = Meter.CreateCounter<long>("pojevarena.jev.failures");
    private static readonly Counter<double> JevCost = Meter.CreateCounter<double>("pojevarena.jev.cost", "USD");
    private static readonly Histogram<double> JevLatency = Meter.CreateHistogram<double>("pojevarena.jev.latency", "ms");

    public static IEndpointRouteBuilder MapPoJevArenaEndpoints(this IEndpointRouteBuilder app)
    {
        ReportJevMode(app.ServiceProvider);

        var group = app.MapGroup("/pojevarena").WithTags("PoJevArena");

        group.MapGet("/status", StatusAsync)
            .WithName("PoJevArenaStatus")
            .WithSummary("Whether Jev is configured, and the caller's remaining daily Jev calls")
            .Produces<ArenaStatus>()
            .RequireRateLimiting("pojevarena");

        group.MapPost("/matches", RegisterMatch)
            .WithName("PoJevArenaRegisterMatch")
            .WithSummary("Freeze two 10-creature rosters into a match and issue its id and seed")
            .Produces<ArenaMatchTicket>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("pojevarena");

        group.MapPost("/matches/{matchId}/decisions", DecideAsync)
            .WithName("PoJevArenaDecide")
            .WithSummary("Ask Jev for 1-8 units' decisions; per-unit failures hold the unit's last intent")
            .Produces<ArenaDecideResponse>()
            .Produces<ArenaDecideResponse>(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("pojevarena-decide");

        return app;
    }

    private static async Task<IResult> StatusAsync(
        HttpContext http, IJevClient jev, JevCallAllowance allowance, CancellationToken ct)
    {
        var owner = Owner(http);
        if (owner is null) return Results.Unauthorized();

        var verdict = await allowance.CheckAsync(AllowanceKey(owner.Value), calls: 0, ct);
        return Results.Ok(new ArenaStatus(jev.IsConfigured, verdict.Limit, verdict.Used, verdict.Remaining, verdict.ResetUtc));
    }

    private static IResult RegisterMatch(
        ArenaMatchRequest request, HttpContext http, IJevClient jev, ArenaMatchRegistry registry)
    {
        var owner = Owner(http);
        if (owner is null) return Results.Unauthorized();
        if (!jev.IsConfigured) return JevUnavailable();

        if (request.BlueIds is not { Length: PoJevArenaCatalog.TeamSize }
            || request.RedIds is not { Length: PoJevArenaCatalog.TeamSize })
        {
            return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "roster-size",
                detail: $"Each team needs exactly {PoJevArenaCatalog.TeamSize} creatures.");
        }

        var blue = Resolve(request.BlueIds);
        var red = Resolve(request.RedIds);
        if (blue is null || red is null)
        {
            return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "unknown-creature",
                detail: "A roster slot names a creature that does not exist.");
        }

        var match = registry.Register(owner.Value.UserId, new ArenaRoster(blue, red), request.Mode);
        return Results.Ok(new ArenaMatchTicket(match.MatchId, match.Seed, blue, red));
    }

    private static async Task<IResult> DecideAsync(
        string matchId,
        ArenaDecideRequest request,
        HttpContext http,
        IJevClient jev,
        ArenaMatchRegistry registry,
        JevCallAllowance allowance,
        ILoggerFactory loggers,
        CancellationToken ct)
    {
        var owner = Owner(http);
        if (owner is null) return Results.Unauthorized();
        if (!jev.IsConfigured) return JevUnavailable();

        var match = registry.Find(matchId, owner.Value.UserId);
        if (match is null)
        {
            return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "match-expired",
                detail: "This match is not live on the server any more; redeploy to start a new one.");
        }

        var units = request.Units ?? [];
        if (units.Length is 0 or > MaxBatch || units.Select(u => u.Unit).Distinct(StringComparer.Ordinal).Count() != units.Length)
        {
            return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "batch",
                detail: $"Send 1-{MaxBatch} distinct units per batch.");
        }

        // Validate and build every prompt first: a unit whose numbers are invalid never reaches
        // Jev and is never charged.
        var prompts = units.Select(u => (Unit: u, Built: JevPromptBuilder.Build(match.Roster, u))).ToArray();
        var callable = prompts.Count(p => p.Built.Prompt is not null);

        var key = AllowanceKey(owner.Value);
        var verdict = await allowance.CheckAsync(key, callable, ct);
        if (!verdict.Allowed)
        {
            http.Response.Headers.RetryAfter =
                Math.Max(1, (int)Math.Ceiling((verdict.ResetUtc - DateTimeOffset.UtcNow).TotalSeconds)).ToString(System.Globalization.CultureInfo.InvariantCulture);
            return Results.Json(
                new ArenaDecideResponse([], verdict.Remaining, "allowance-exhausted"),
                statusCode: StatusCodes.Status429TooManyRequests);
        }

        // Charged before the fan-out so two concurrent batches cannot both pass a nearly-spent
        // allowance; the worst case is one batch of overshoot. Failed calls still cost a request.
        allowance.Record(key, callable);

        var user = Hash(key);
        var clock = Stopwatch.StartNew();
        var results = await Task.WhenAll(prompts.Select(async p =>
        {
            if (p.Built.Prompt is null) return (Decision: Failed(p.Unit.Unit, "invalid:" + p.Built.Error, 0), CostUsd: 0d);
            var outcome = await jev.EvaluateAsync(p.Built.Prompt, match.MatchId, user, ct);
            JevLatency.Record(outcome.LatencyMs);
            return (Decision: ToDecision(p.Unit.Unit, outcome), CostUsd: outcome.Usage?.CostUsd ?? 0);
        }));

        var decisions = results.Select(r => r.Decision).ToArray();
        var ok = decisions.Count(d => d.Ok);
        var cost = results.Sum(r => r.CostUsd);
        JevCost.Add(cost);
        match.RecordDecisions(ok, cost);

        JevCalls.Add(callable);
        JevFailures.Add(decisions.Length - ok);
        loggers.CreateLogger(typeof(PoJevArenaEndpoints)).DecisionBatch(
            match.MatchId, decisions.Length, ok, decisions.Length - ok, cost, clock.ElapsedMilliseconds);

        // A key/credit problem fails every unit the same way; say so once for the banner.
        var notice = decisions.Any(d => d.Failure is "http-401" or "http-402" or "http-403") ? "jev-rejected" : null;
        return Results.Ok(new ArenaDecideResponse(decisions, Math.Max(0, verdict.Remaining - callable), notice));
    }

    /// <summary>Presets resolve from the catalog; library ids are wired in with the creature store.</summary>
    private static ArenaCreature[]? Resolve(string[] ids)
    {
        var resolved = new ArenaCreature[ids.Length];
        for (var i = 0; i < ids.Length; i++)
        {
            var creature = PoJevArenaCatalog.FindPreset(ids[i]);
            if (creature is null) return null;
            resolved[i] = creature;
        }
        return resolved;
    }

    private static ArenaUnitDecision ToDecision(string unit, JevOutcome outcome)
    {
        if (!outcome.Ok || outcome.Answers is not { } a) return Failed(unit, outcome.Failure ?? "unknown", outcome.LatencyMs);

        return new ArenaUnitDecision(
            unit, true, null,
            a.Action, a.ActionConfidence, a.ActionProbabilities,
            a.Focus, a.FocusConfidence, a.FocusProbabilities,
            a.Panic, outcome.LatencyMs);
    }

    private static ArenaUnitDecision Failed(string unit, string failure, int latencyMs) =>
        new(unit, false, failure, null, 0, null, null, 0, null, 0, latencyMs);

    private static IResult JevUnavailable() =>
        Results.Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "jev-unavailable",
            detail: "PoJevArena needs Jev, and no Jev key is configured on this server.");

    /// <summary>The caller's stable identity, or null when there is nothing to bind a match or an allowance to.</summary>
    private static RequestIdentity.Identity? Owner(HttpContext http)
    {
        var identity = RequestIdentity.Resolve(http.User);
        if (!string.IsNullOrEmpty(identity.UserId)) return identity;
        // Same fallback as the PoEcosystem slice: a cookie session without a stable id partitions by name.
        return string.IsNullOrEmpty(identity.DisplayName) ? null : identity with { UserId = "name:" + identity.DisplayName };
    }

    private static string AllowanceKey(RequestIdentity.Identity owner) => "id:" + owner.UserId;

    /// <summary>What OpenRouter sees as <c>user</c>: stable per player for abuse tracking, never the raw claim id.</summary>
    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..24].ToLowerInvariant();

    private static void ReportJevMode(IServiceProvider services)
    {
        var options = services.GetRequiredService<IOptions<JevOptions>>().Value;
        var environment = services.GetRequiredService<IHostEnvironment>();
        var logger = services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(PoJevArenaEndpoints));

        if (options.UseStub && environment.IsEnvironment("Test")) logger.JevStubEnabled(environment.EnvironmentName);
        else if (!options.IsConfigured) logger.JevNotConfigured();
    }
}
