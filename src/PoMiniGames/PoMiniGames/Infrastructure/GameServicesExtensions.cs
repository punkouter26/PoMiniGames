using PoMiniGames.Domain.Services;
using PoMiniGames.Features.PoCoupleQuiz;
using PoMiniGames.Features.PoCoupleQuiz.Storage;
using PoMiniGames.Features.PoFunQuiz;
using PoMiniGames.Features.PoFunQuiz.Storage;
using PoMiniGames.Features.PoRaceRagdoll;
using PoMiniGames.Infrastructure.Services;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Registers all game-specific services used by the local-only app.
/// </summary>
internal static class GameServicesExtensions
{
    public static IServiceCollection AddPoMiniGamesGameServices(this IServiceCollection services)
    {
        // PoRaceRagdoll
        services.AddSingleton<IRacerService, RacerService>();
        services.AddSingleton<IGameSessionService, GameSessionService>();

        // Elo calculation with configurable options
        services.Configure<EloOptions>(options =>
        {
            // Default values from EloOptions class will be used unless overridden in config
        });
        services.AddSingleton(sp =>
        {
            var config = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<EloOptions>>();
            return new EloCalculator(config.Value);
        });

        // Storage initializer for the consolidated games (PoCoupleQuiz, PoFunQuiz, PoFace).
        // Ensures all per-game tables and blob containers exist at host startup.
        services.AddSingleton<StorageInitializer>();

        // Fail-fast startup validator: throws in Production if any consolidated game's
        // required Azure OpenAI secrets are missing. See PoFunQuiz StartupSecretValidator
        // (2026-06-13 mock-data fix) for the original pattern.
        services.AddHostedService<StartupSecretValidator>();

        // PoCoupleQuiz — Phase 1 of the consolidation. See Features/PoCoupleQuiz/.
        // The question service resolves to the mock in Dev/Test when UseMockAi=true
        // or Azure OpenAI is not configured; in Production it always uses the real
        // service (StartupSecretValidator fails-fast if the secrets are missing).
        // CoupleQuizOptions is bound in Program.cs before AddPoMiniGamesGameServices.
        services.AddSingleton<IGameSessionManager, GameSessionManager>();
        // Note: GameSessionManager is a pure in-memory state holder, not a hosted service.
        // Background timers (round timers, host-promote grace periods) are owned by the hub.
        services.AddSingleton<GameSessionManager>(sp => (GameSessionManager)sp.GetRequiredService<IGameSessionManager>());
        services.AddSingleton<IQuestionService, AzureOpenAIQuestionService>();
        services.AddSingleton<MockQuestionService>();
        services.AddSingleton<ITeamsRepository, TeamsRepository>();
        services.AddSingleton<IGameHistoryRepository, GameHistoryRepository>();

        // PoFunQuiz — Phase 2 of the consolidation. See Features/PoFunQuiz/.
        // AzureOpenAIService is the production path; mock fallback is gated to Dev/Test
        // inside the service. The leaderboard repository writes to the
        // PoFunQuizPlayers table (PartitionKey = Category, RowKey = Guid).
        services.AddMemoryCache();
        services.AddSingleton<IOpenAIService, AzureOpenAIService>();
        services.AddSingleton<ILeaderboardRepository, LeaderboardRepository>();

        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.Converters.Add(
                new System.Text.Json.Serialization.JsonStringEnumConverter());
        });

        return services;
    }
}
