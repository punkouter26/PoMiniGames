namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// The HTTP surface for PoCoupleQuiz. The whole game lifecycle runs over the SignalR hub
/// (<see cref="CoupleQuizHub"/>); all that is left here is the runtime-status probe that
/// drives the "USING MOCK DATA" banner.
/// </summary>
/// <remarks>
/// <para><b>2026-08-10 simplification.</b> This group had eleven routes and the client called
/// none of them:</para>
/// <list type="bullet">
/// <item><c>/lobby/{code}/exists</c> and <c>/lobby/{code}/status</c> — page-refresh recovery for
/// game codes that no longer exist.</item>
/// <item><c>/questions/generate</c> and <c>/questions/check-similarity</c> — an anonymous,
/// rate-limited path to two paid model calls, kept for an in-browser AI engine that was never
/// built. The hub calls <see cref="IQuestionService"/> directly.</item>
/// <item><c>/teams</c>, <c>/teams/{name}</c>, <c>/teams/{name}/stats</c>,
/// <c>/teams/leaderboard</c>, <c>/leaderboard</c> and <c>/game-history</c> — the Teams
/// subsystem. Nothing in the game ever created a team or updated one, so the
/// <c>PoCoupleQuizTeams</c> table stayed empty and the Couple Quiz leaderboard was permanently
/// padded placeholder rows. The board now reads the same PlayerStats records every other
/// win-rate game uses, which the client actually writes on game over.</item>
/// </list>
/// </remarks>
public static class CoupleQuizEndpoints
{
    public static IEndpointRouteBuilder MapCoupleQuizEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/couplequiz").WithTags("PoCoupleQuiz");

        // ── Runtime status (drives the per-game "USING MOCK DATA" banner) ──

        group.MapGet("/runtime/status", (IHostEnvironment env, IConfiguration cfg) =>
        {
            var useMockAi = cfg.GetValue<bool>("PoCoupleQuiz:Features:UseMockAI");
            return Results.Ok(new
            {
                game = "pocouplequiz",
                isMockData = useMockAi && (env.IsDevelopment() || env.IsEnvironment("Test")),
                useMockAi,
                environment = env.EnvironmentName
            });
        })
        .WithName("CoupleQuiz_RuntimeStatus")
        .WithSummary("PoCoupleQuiz runtime status (used by the mock-data banner)");

        return app;
    }
}
