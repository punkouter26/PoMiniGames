using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Features.PoCoupleQuiz.Storage;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Minimal-API endpoints for PoCoupleQuiz: lobby status (anon), questions, teams, and
/// diagnostics. The live multiplayer lifecycle is driven by the SignalR hub
/// (<see cref="CoupleQuizHub"/>) — these endpoints exist for page-refresh recovery,
/// one-off AI calls, and team-stat management.
/// </summary>
public static class CoupleQuizEndpoints
{
    public static IEndpointRouteBuilder MapCoupleQuizEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/couplequiz").WithTags("PoCoupleQuiz");

        // ── Lobby status (anonymous — page-refresh recovery) ─────────────

        group.MapGet("/lobby/{code}/exists", (string code, IGameSessionManager sessions) =>
        {
            var normalized = code.Trim().ToUpperInvariant();
            return sessions.LobbyExists(normalized)
                ? Results.Ok(new { code = normalized, exists = true })
                : Results.Ok(new { code = normalized, exists = false });
        })
        .WithName("CoupleQuiz_LobbyExists")
        .WithSummary("Check whether a lobby with the given code exists");

        group.MapGet("/lobby/{code}/status", (string code, IGameSessionManager sessions) =>
        {
            var session = sessions.GetSession(code.Trim().ToUpperInvariant());
            if (session is null) return Results.NotFound();
            return Results.Ok(new
            {
                code = session.GameCode,
                state = session.State.ToString(),
                players = session.Players.Select(p => p.Name).ToList(),
                hostName = session.HostName,
                difficulty = session.Difficulty.ToString(),
                aiMode = session.AiMode
            });
        })
        .WithName("CoupleQuiz_LobbyStatus")
        .WithSummary("Get the current state of a lobby (page-refresh recovery)");

        // ── Questions / AI scoring (anonymous — used by the in-browser AI path) ─

        group.MapPost("/questions/generate", async (
            [FromBody] GenerateQuestionRequest request,
            IQuestionService questionService,
            CancellationToken cancellationToken) =>
        {
            var difficulty = Enum.TryParse<DifficultyLevel>(request.Difficulty, ignoreCase: true, out var d)
                ? d
                : DifficultyLevel.Medium;
            var category = !string.IsNullOrWhiteSpace(request.Category)
                && Enum.TryParse<QuestionCategory>(request.Category, ignoreCase: true, out var c)
                    ? (QuestionCategory?)c
                    : null;
            var question = await questionService.GenerateQuestionAsync(difficulty, category, cancellationToken);
            return Results.Ok(new { text = question.Text, category = question.Category.ToString() });
        })
        .WithName("CoupleQuiz_GenerateQuestion")
        .WithSummary("Generate a single PoCoupleQuiz question (Remote AI engine)");

        group.MapPost("/questions/check-similarity", async (
            [FromBody] CheckSimilarityRequest request,
            IQuestionService questionService,
            CancellationToken cancellationToken) =>
        {
            var score = await questionService.CheckAnswerSimilarityAsync(request.Answer1, request.Answer2, cancellationToken);
            return Results.Ok(new { score });
        })
        .WithName("CoupleQuiz_CheckSimilarity")
        .WithSummary("Score semantic similarity between two short answers (0.0-1.0)");

        // ── Teams (cross-game persistent stats) ────────────────────────────

        group.MapGet("/teams", async (ITeamsRepository repo, CancellationToken ct) =>
        {
            var teams = await repo.GetAllTeamsAsync(ct);
            return Results.Ok(teams);
        })
        .WithName("CoupleQuiz_ListTeams");

        group.MapGet("/teams/{name}", async (string name, ITeamsRepository repo, CancellationToken ct) =>
        {
            var team = await repo.GetTeamAsync(name, ct);
            return team is null ? Results.NotFound() : Results.Ok(team);
        })
        .WithName("CoupleQuiz_GetTeam");

        // GET counterpart of the PUT /teams/{name}/stats route. Returns a flat
        // stats payload so the leaderboard UI can fetch a single team's
        // summary without downloading the full team record. Returns 404 when
        // the team has never played.
        group.MapGet("/teams/{name}/stats", async (string name, ITeamsRepository repo, CancellationToken ct) =>
        {
            var team = await repo.GetTeamAsync(name, ct);
            if (team is null) return Results.NotFound(new { error = $"Team '{name}' not found" });
            var accuracy = team.TotalQuestionsAnswered > 0
                ? Math.Round((double)team.CorrectAnswers / team.TotalQuestionsAnswered, 3)
                : 0d;
            return Results.Ok(new
            {
                name = team.Name,
                highScore = team.HighScore,
                totalQuestionsAnswered = team.TotalQuestionsAnswered,
                correctAnswers = team.CorrectAnswers,
                accuracy,
                lastPlayed = team.LastPlayed,
            });
        })
        .WithName("CoupleQuiz_GetTeamStats")
        .WithSummary("Get a single team's PoCoupleQuiz stats summary");

        // Leaderboard view: all teams ordered by HighScore DESC, then accuracy.
        group.MapGet("/teams/leaderboard", async (ITeamsRepository repo, int limit = 25, CancellationToken ct = default) =>
        {
            var teams = await repo.GetAllTeamsAsync(ct);
            var rows = teams
                .OrderByDescending(t => t.HighScore)
                .ThenByDescending(t => t.TotalQuestionsAnswered == 0 ? 0 : (double)t.CorrectAnswers / t.TotalQuestionsAnswered)
                .Take(Math.Clamp(limit, 1, 100))
                .Select((t, i) => new
                {
                    rank = i + 1,
                    name = t.Name,
                    highScore = t.HighScore,
                    totalQuestionsAnswered = t.TotalQuestionsAnswered,
                    correctAnswers = t.CorrectAnswers,
                    accuracy = t.TotalQuestionsAnswered == 0 ? 0d : Math.Round((double)t.CorrectAnswers / t.TotalQuestionsAnswered, 3),
                    lastPlayed = t.LastPlayed,
                });
            return Results.Ok(rows);
        })
        .WithName("CoupleQuiz_TeamLeaderboard")
        .WithSummary("Top PoCoupleQuiz teams ordered by high score (tie-break: accuracy)");

        group.MapPost("/teams", async (Team team, ITeamsRepository repo, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(team.Name)) return Results.BadRequest(new { error = "Name is required" });
            await repo.SaveTeamAsync(team, ct);
            return Results.Created($"/api/couplequiz/teams/{team.Name}", team);
        })
        .WithName("CoupleQuiz_SaveTeam");

        group.MapPut("/teams/{name}/stats", async (
            string name,
            [FromBody] UpdateStatsRequest body,
            ITeamsRepository repo,
            CancellationToken ct) =>
        {
            if (body.Score < 0 || body.QuestionsAnswered < 0 || body.CorrectAnswers < 0)
            {
                return Results.BadRequest(new { error = "Values must be non-negative" });
            }
            await repo.UpdateStatsAsync(name, body.Score, body.QuestionsAnswered, body.CorrectAnswers, ct);
            return Results.NoContent();
        })
        .WithName("CoupleQuiz_UpdateStats");

        // ── Game history (auth) ───────────────────────────────────────────

        group.MapPost("/game-history", async (
            GameHistory history,
            IGameHistoryRepository repo,
            CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(history.GameSessionId))
            {
                return Results.BadRequest(new { error = "GameSessionId is required" });
            }
            await repo.SaveGameHistoryAsync(history, ct);
            return Results.Created($"/api/couplequiz/game-history/{history.GameSessionId}", history);
        })
        .RequireAuthorization()
        .WithName("CoupleQuiz_SaveGameHistory");

        // ── Runtime status (drives the per-game "USING MOCK DATA" banner) ──

        group.MapGet("/runtime/status", (IHostEnvironment env, IConfiguration cfg) =>
        {
            var useMockAi = cfg.GetValue<bool>("PoCoupleQuiz:Features:UseMockAi");
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

public record GenerateQuestionRequest(string? Difficulty, string? Category);
public record CheckSimilarityRequest(string Answer1, string Answer2);
