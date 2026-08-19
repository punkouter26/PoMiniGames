using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Diagnostics;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.HighScores;     // PoSports mapper
using PoMiniGames.Features.PoBrawl;        // moved out of Features.HighScores 2026-08-11,
                                           // same correction PoMarbleRace already had
using PoMiniGames.Features.PoMarbleRace;   // moved out of Features.HighScores so the
                                           // namespace matches its own slice folder
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.MatchHistory;
using PoMiniGames.Features.PoCoupleQuiz;
using PoMiniGames.Features.PoFunQuiz;
using PoMiniGames.Features.PoJoker;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Features.PoSurvive;
using PoMiniGames.Features.PoVoxelStrike;

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
        // §2 CSRF token issuer. Anonymous + GET, so it stays reachable before sign-in
        // and is itself exempt from the validation gate it feeds.
        app.MapAntiforgeryEndpoints();
        app.MapHealthEndpoints();
        // AI usage read-model. Grouped with the health probes rather than behind the game-API auth
        // gate because it is a diagnostics surface, and it reports no other identity's spend — only
        // aggregate per-game counters plus the caller's own allowance.
        app.MapAiUsageEndpoints();
        app.MapDiagEndpoints();
        app.MapMockablesEndpoints();
        // MapTelemetryStatusEndpoints removed 2026-08-18: /api/diag/telemetry had zero
        // consumers — no client call, no test, no doc. /api/diag already reports the
        // telemetry configuration state.
        // MapTestHarnessEndpoints removed 2026-08-07. The three /test/* routes
        // (offline-mode, render-diagnostics, api-timeout) returned instructions for a
        // developer to follow by hand, and their only consumer was Pages/TestPage.razor,
        // which was deleted with the rest of the dev-only UI. They were already
        // Development-gated, so nothing shipped — but nothing called them either.

        // ── Public read-only leaderboards (guest-first) ────────────────────
        // §10 A brand-new visitor can browse the boards before signing in, so
        // the leaderboard READ endpoints are anonymous. These are pure GETs
        // (no writes), and default authorization is anonymous — the only reason
        // they were gated before was the authenticated group below. Score
        // SUBMIT paths stay authenticated (guests park scores locally and flush
        // them on sign-in), so anonymous read never becomes anonymous write.
        app.MapGetLeaderboard();
        app.MapUnifiedLeaderboardEndpoints();
        // PoVoxelStrike voxel assets are read-only game content (content-addressed,
        // immutable), so they sit with the anonymous reads; the M4 run-submission POST
        // will join the authenticated group below instead.
        app.MapPoVoxelStrikeAssetEndpoints();

        // ── Authenticated game API ─────────────────────────────────────────
        // All game-data endpoints require a valid session. Per-endpoint rate
        // limits (highscores, ai-generation, face-analysis, infer) are declared
        // inside each slice; the group adds the auth gate only.
        var gameApi = app.MapGroup("").RequireAuthorization();

        gameApi.MapGetPlayerStats();
        gameApi.MapSavePlayerStats();
        gameApi.MapGetAllPlayerStatistics();
        gameApi.MapMarbleRaceHighScoresEndpoints();
        gameApi.MapPoBrawlLeaderboardEndpoints();
        gameApi.MapMatchHistoryEndpoints();
        gameApi.MapCoupleQuizEndpoints();
        gameApi.MapFunQuizEndpoints();
        gameApi.MapPoJokerEndpoints();
        gameApi.MapPoRacerScoreEndpoints();
        gameApi.MapPoSportsHighScoresEndpoints();
        gameApi.MapPoSurviveEndpoints(app.Configuration);
        gameApi.MapPoVoxelStrikeScoreEndpoints();

        // ── SignalR hubs (auth required; not part of MapGroup) ────────────
        app.MapHub<CoupleQuizHub>("/couplequiz/hubs/game").RequireAuthorization();
        app.MapHub<FunQuizHub>("/funquiz/gamehub").RequireAuthorization();
        app.MapHub<PoRacerLobbyHub>("/poracer/lobby-hub").RequireAuthorization();
        app.MapHub<PoRacerRaceHub>("/poracer/race-hub").RequireAuthorization();
        app.MapHub<PoMiniGames.Features.PoSports.PoSportsLobbyHub>("/posports/lobby-hub").RequireAuthorization();
        app.MapHub<PoMiniGames.Features.PoSports.PoSportsRaceHub>("/posports/race-hub").RequireAuthorization();
        // PoVoxelStrike co-op: lobby hub for the ready/start room, lockstep hub for the
        // active run. Both follow the platform pattern (auth required, separate from
        // MapGroup because MapHub returns IHubEndpointConventionBuilder).
        app.MapHub<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLobbyHub>("/povoxelstrike/lobby-hub").RequireAuthorization();
        app.MapHub<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLockstepHub>("/povoxelstrike/lockstep-hub").RequireAuthorization();

        return app;
    }
}
