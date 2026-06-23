using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
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
        var group = app.MapGroup("/api/funquiz").WithTags("PoFunQuiz");

        // ── Question generation (with a tiny in-memory cache to dedupe repeats) ──

        group.MapGet("/quiz/questions", async (
            [FromQuery] int count,
            [FromQuery] string? category,
            IOpenAIService ai,
            IMemoryCache cache,
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
            var key = $"funquiz:q:{cat}:{count}";

            if (!cache.TryGetValue(key, out IReadOnlyList<QuizQuestion>? cached))
            {
                var generated = await ai.GenerateQuizQuestionsAsync(cat, count, cancellationToken);
                cached = generated;
                cache.Set(key, cached, TimeSpan.FromSeconds(60));
            }
            return Results.Ok(cached);
        })
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

        // ── Runtime status (drives the per-game "USING MOCK DATA" banner) ──

        group.MapGet("/runtime/status", (IHostEnvironment env, IConfiguration cfg) =>
        {
            var useMock = cfg.GetValue<bool>("PoFunQuiz:Features:UseMockAI");
            return Results.Ok(new
            {
                game = "pofunquiz",
                isMockData = useMock && (env.IsDevelopment() || env.IsEnvironment("Test")),
                useMockAi = useMock,
                environment = env.EnvironmentName
            });
        })
        .WithName("FunQuiz_RuntimeStatus");

        // ── Open games (lobby browser) ─────────────────────────────────────

        group.MapGet("/lobby/open", (MultiplayerLobbyService lobby) =>
        {
            return Results.Ok(lobby.ListOpen());
        })
        .WithName("FunQuiz_ListOpenGames")
        .WithSummary("List PoFunQuiz games waiting for a second player");

        return app;
    }
}
