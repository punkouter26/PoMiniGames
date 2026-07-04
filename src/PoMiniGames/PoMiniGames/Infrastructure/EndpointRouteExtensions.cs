using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Diagnostics;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.HighScores;     // MarbleRace / PoBrawl mappers
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.MatchHistory;
using PoMiniGames.Features.PoCoupleQuiz;
using PoMiniGames.Features.PoFace;
using PoMiniGames.Features.PoFunQuiz;
using PoMiniGames.Features.PoJoker;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Features.PoRunner;
using PoMiniGames.Features.PoSurvive;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Single, ordered registration point for every HTTP endpoint and SignalR hub.
/// Program.cs maps the whole surface with one <c>app.MapPoMiniGamesEndpoints()</c>
/// call, so the route table is described in exactly one place.
///
/// Groups use <c>MapGroup("")</c> (empty prefix) to preserve existing route paths
/// while applying cross-cutting policies — auth and per-game rate limits — at the
/// group boundary rather than per-endpoint. SignalR hubs are mapped directly on
/// <c>app</c> because <c>MapHub&lt;T&gt;</c> returns <c>IHubEndpointConventionBuilder</c>,
/// which is not an <c>IEndpointConventionBuilder</c> and cannot be composed inside a group.
/// </summary>
internal static class EndpointRouteExtensions
{
    public static WebApplication MapPoMiniGamesEndpoints(this WebApplication app)
    {
        // ── Platform: unprotected (auth flow, health probes, diagnostics) ──
        app.MapAuthEndpoints();
        app.MapHealthEndpoints();
        app.MapDiagEndpoints();
        app.MapMockablesEndpoints();
        app.MapTelemetryStatusEndpoints();
        app.MapTestHarnessEndpoints(app.Environment);

        // ── Authenticated game API ─────────────────────────────────────────
        // All game-data endpoints require a valid session. Per-endpoint rate
        // limits (highscores, ai-generation, face-analysis, infer) are declared
        // inside each slice; the group adds the auth gate only.
        var gameApi = app.MapGroup("").RequireAuthorization();

        gameApi.MapGetPlayerStats();
        gameApi.MapSavePlayerStats();
        gameApi.MapGetLeaderboard();
        gameApi.MapUnifiedLeaderboardEndpoints();
        gameApi.MapGetAllPlayerStatistics();
        gameApi.MapMarbleRaceHighScoresEndpoints();
        gameApi.MapPoBrawlHighScoresEndpoints();
        gameApi.MapMatchHistoryEndpoints();
        gameApi.MapCoupleQuizEndpoints();
        gameApi.MapFunQuizEndpoints();
        gameApi.MapFaceEndpoints();
        gameApi.MapPoJokerEndpoints();
        gameApi.MapPoRacerScoreEndpoints();
        gameApi.MapPoSurviveEndpoints(app.Configuration);

        // ── SignalR hubs (auth required; not part of MapGroup) ────────────
        app.MapHub<CoupleQuizHub>("/couplequiz/hubs/game").RequireAuthorization();
        app.MapHub<FunQuizHub>("/funquiz/gamehub").RequireAuthorization();
        app.MapHub<GameHub>("/porunner/gamehub").RequireAuthorization();
        app.MapHub<PoRacerLobbyHub>("/poracer/lobby-hub").RequireAuthorization();

        return app;
    }
}
