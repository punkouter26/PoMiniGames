using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Hybrid;
using PoMiniGames.Features.PoFunQuiz.Storage;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// Minimal-API endpoints for PoFunQuiz: question generation, leaderboard submit / fetch,
/// and per-game runtime status. Real-time multiplayer (lobby + score updates) is handled
/// by the SignalR hub (<see cref="FunQuizHub"/>) in a follow-up. This MVP serves the
/// Solo mode and the leaderboard.
/// </summary>
public static class FunQuizEndpoints
{
    public static IEndpointRouteBuilder MapFunQuizEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/funquiz").WithTags("PoFunQuiz");

        // ── Question generation ──────────────────────────────────────────
        // 2026-09-12: the 60-second HybridCache that used to wrap this call is GONE.
        // It memoized the finished, already-dealt list of questions under
        // `funquiz:q:{category}:{count}`, so every game started inside the same minute
        // received a byte-identical quiz — same questions, same order, same option order.
        // That defeated the per-game shuffling in AiQuizGeneratorService.SelectVariedSet
        // and was a large part of why the quiz felt canned.
        //
        // Removing it costs nothing upstream, which is the point: the generator has its
        // OWN HybridCache over the question POOL (6 h, stampede-protected), so concurrent
        // requests still collapse into a single model call. The difference is that the
        // layer which is allowed to cache now caches the raw material, and the dealing —
        // which subset, in which order, with options shuffled — happens per request.
        // Cache the pool, not the hand.

        group.MapGet("/quiz/questions", async (
            [FromQuery] int count,
            [FromQuery] string? category,
            IOpenAIService ai,
            CancellationToken cancellationToken) =>
        {
            if (count <= 0) count = 10;
            if (count > 50) return Results.StatusCode(StatusCodes.Status429TooManyRequests);
            if (string.Equals(category, "BrowserAI", StringComparison.OrdinalIgnoreCase))
            {
                return Results.BadRequest(new { error = "BrowserAI must be invoked client-side; this endpoint serves server-side AI only." });
            }

            var cat = Enum.TryParse<QuestionCategory>(category, ignoreCase: true, out var c)
                ? c
                : QuestionCategory.General;
            // Called directly. The AsyncLocal identity the request middleware set is still on
            // this flow here — the note that used to sit here explained why it had to be carried
            // in HybridCache factory state instead (the factory runs off-flow, so a generation
            // was billed to nobody: measured at 809 tokens against a 0-token budget entry). That
            // hazard belongs to the generator's internal cache now, which handles it there.
            var questions = await ai.GenerateQuizQuestionsAsync(cat, count, cancellationToken);
            return Results.Ok(questions);
        })
        .RequireRateLimiting("ai-generation")
        .WithName("FunQuiz_GetQuestions")
        .WithSummary("Generate PoFunQuiz questions (gpt-5-nano on the shared po-aiservices-shared account)");

        // ── Leaderboard ────────────────────────────────────────────────────────

        group.MapGet("/leaderboard", async (
            [FromQuery] string? category,
            [FromQuery] int? top,
            ILeaderboardRepository repo,
            CancellationToken cancellationToken) =>
        {
            var cat = Enum.TryParse<QuestionCategory>(category, ignoreCase: true, out var c) ? c : QuestionCategory.General;
            var entries = await repo.GetTopAsync(cat, top ?? 10, cancellationToken);
            return Results.Ok(entries);
        })
        .WithName("FunQuiz_GetLeaderboard")
        .WithSummary("Top PoFunQuiz players for a category");

        group.MapPost("/leaderboard", async (
            [FromBody] LeaderboardEntry body,
            HttpContext ctx,
            ILeaderboardRepository repo,
            CancellationToken cancellationToken) =>
        {
            // Anti-spoof: override any client-supplied PlayerName with the email claim
            // (or a "anon-<guid>" marker for guest users). The client only sets Category
            // and Score. (See the source PoFunQuiz.SubmitScore pattern.)
            var email = ctx.User?.FindFirst(ClaimTypes.Email)?.Value
                ?? ctx.User?.FindFirst("preferred_username")?.Value;
            if (!string.IsNullOrWhiteSpace(email))
            {
                body.PlayerName = email;
            }
            else
            {
                body.PlayerName = $"anon-{Guid.NewGuid():N}".Substring(0, 16);
            }
            body.Score = Math.Clamp(body.Score, 0, 10_000);
            await repo.SubmitAsync(body, cancellationToken);
            return Results.Created("/api/funquiz/leaderboard", body);
        })
        .RequireAuthorization()
        .WithName("FunQuiz_SubmitLeaderboard");

        // GET /runtime/status and GET /lobby/open were removed 2026-08-31: neither had a client
        // or test consumer. The mock-data banner reads AuthState.UsingMockData (server-injected),
        // not a per-game probe, and the lobby browser surfaces open games through the SignalR
        // hub rather than this REST list.

        return app;
    }
}
