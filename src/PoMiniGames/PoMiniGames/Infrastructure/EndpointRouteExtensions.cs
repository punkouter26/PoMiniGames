using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Diagnostics;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.HighScores;     // HighScores + MarbleRace mappers
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.MatchHistory;
using PoMiniGames.Features.PoCoupleQuiz;
using PoMiniGames.Features.PoFace;
using PoMiniGames.Features.PoFunQuiz;
using PoMiniGames.Features.PoJoker;
using PoMiniGames.Features.PoRaceRagdoll;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Features.PoRunner;
using PoMiniGames.Features.PoSurvive;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Single, ordered registration point for every HTTP endpoint and SignalR hub.
/// Program.cs maps the whole surface with one <c>app.MapPoMiniGamesEndpoints()</c>
/// call, so the route table is described in exactly one place. Routes are left at
/// their historical paths (no <c>/api</c> reparenting) because the WASM client and
/// the SignalR hubs call these exact URLs.
/// </summary>
internal static class EndpointRouteExtensions
{
    public static WebApplication MapPoMiniGamesEndpoints(this WebApplication app)
    {
        // ── Platform: auth, health, diagnostics, test harness ──────────────
        app.MapAuthEndpoints();
        app.MapHealthEndpoints();
        app.MapDiagEndpoints();
        app.MapMockablesEndpoints();
        app.MapTestHarnessEndpoints(app.Environment);

        // ── Stats, leaderboards & cross-game history ───────────────────────
        app.MapGetPlayerStats();
        app.MapSavePlayerStats();
        app.MapGetLeaderboard();
        app.MapUnifiedLeaderboardEndpoints();
        app.MapGetAllPlayerStatistics();
        app.MapHighScoresEndpoints();
        app.MapMarbleRaceHighScoresEndpoints();
        app.MapMatchHistoryEndpoints();

        // ── PoRaceRagdoll ──────────────────────────────────────────────────
        app.MapGameEndpoints();

        // ── PoCoupleQuiz (endpoints + hub) ─────────────────────────────────
        app.MapCoupleQuizEndpoints();
        app.MapHub<CoupleQuizHub>("/couplequiz/hubs/game");

        // ── PoFunQuiz (Solo HTTP path + hub) ───────────────────────────────
        app.MapFunQuizEndpoints();
        app.MapHub<FunQuizHub>("/funquiz/gamehub");

        // ── PoFace (HTTP-only in the consolidation MVP) ────────────────────
        app.MapFaceEndpoints();

        // ── PoJoker (demo-only autonomous comedy show; HTTP-only) ──────────
        app.MapPoJokerEndpoints();

        // ── PoRunner (SignalR) ─────────────────────────────────────────────
        app.MapHub<GameHub>("/porunner/gamehub");

        // ── PoRacer (SignalR lobby + scores) ───────────────────────────────
        app.MapHub<PoRacerLobbyHub>("/poracer/lobby-hub");
        app.MapPoRacerScoreEndpoints();

        // ── PoSurvive (agent survival simulation) ──────────────────────────
        app.MapPoSurviveEndpoints(app.Configuration);

        return app;
    }
}
