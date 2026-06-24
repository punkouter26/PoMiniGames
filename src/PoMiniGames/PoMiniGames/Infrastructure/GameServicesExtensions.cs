using PoMiniGames.Domain.Services;
using PoMiniGames.Features.PoCoupleQuiz;
using PoMiniGames.Features.PoCoupleQuiz.Storage;
using PoMiniGames.Features.PoFace;
using PoMiniGames.Features.PoFace.Storage;
using PoMiniGames.Features.PoFunQuiz;
using PoMiniGames.Features.PoFunQuiz.Storage;
using PoMiniGames.Features.PoJoker;
using PoMiniGames.Features.PoJoker.Storage;
using PoMiniGames.Features.PoRaceRagdoll;
using PoMiniGames.Infrastructure.Services;

// Aliases to disambiguate the identically-named ILeaderboardRepository and
// IGameSessionRepository in the per-game Storage namespaces.
using FaceLeaderboardRepository = PoMiniGames.Features.PoFace.Storage.LeaderboardRepository;
using FaceLeaderboardEntry = PoMiniGames.Features.PoFace.LeaderboardEntry;
using FaceGameSessionRepository = PoMiniGames.Features.PoFace.Storage.GameSessionRepository;
using FacePlayerStatsRepository = PoMiniGames.Features.PoFace.Storage.PlayerStatsRepository;

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

        // MatchHistory — cross-game head-to-head record (local 2P + online multiplayer).
        // Writes to the MatchHistory table (PartitionKey = owner identity, RowKey = reverse-time).
        services.AddSingleton<PoMiniGames.Features.MatchHistory.MatchHistoryRepository>();

        // Fail-fast startup validator: throws in Production if any consolidated game's
        // required Azure OpenAI secrets are missing. See PoFunQuiz StartupSecretValidator
        // (2026-06-13 mock-data fix) for the original pattern.
        services.AddHostedService<StartupSecretValidator>();

        // PoCoupleQuiz — Phase 1 of the consolidation. See Features/PoCoupleQuiz/.
        // The question service resolves to the mock in Dev/Test when UseMockAI=true
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
        // MultiplayerLobbyService is the in-memory registry for the SignalR hub
        // (CreateGame/JoinGame/StartGame/UpdateScore/PlayerFinished).
        services.AddMemoryCache();
        // §3.4 HybridCache: stampede-protected memoization for deterministic, expensive
        // Azure OpenAI calls (answer-similarity scoring). Question generation is left
        // uncached on purpose so gameplay stays varied.
        services.AddHybridCache();
        services.AddSingleton<IOpenAIService, AzureOpenAIService>();
        services.AddSingleton<PoMiniGames.Features.PoFunQuiz.Storage.ILeaderboardRepository,
            PoMiniGames.Features.PoFunQuiz.Storage.LeaderboardRepository>();
        services.AddSingleton<MultiplayerLobbyService>();

        // PoFace — Phase 3 of the consolidation. See Features/PoFace/.
        // The AzureAIFaceAnalysisService uses the shared multimodal deployment on
        // po-aiservices-shared; the StubFaceAnalysisService implements IFaceAnalysisService
        // and reports IsMock=true (drives the per-game "USING MOCK DATA" banner).
        // §3.4: typed HttpClient via IHttpClientFactory + standard resilience handler
        // (retry x3 with exponential backoff + jitter, circuit breaker at 30% failure,
        // 30s total request timeout). The named client below is the one consumed by
        // AzureAIFaceAnalysisService.
        // CorrelationPropagationHandler needs the ambient HttpContext to read the
        // request's correlation/session ids and forward them upstream.
        services.AddHttpContextAccessor();
        services.AddTransient<CorrelationPropagationHandler>();
        services.AddHttpClient(AzureAIFaceAnalysisService.HttpClientName, client =>
            {
                // 30s, not 60s: this serves a real-time game; a request that hasn't
                // returned in 30s is already a failed round from the player's view.
                client.Timeout = TimeSpan.FromSeconds(30);
            })
            .AddHttpMessageHandler<CorrelationPropagationHandler>()
            .AddStandardResilienceHandler();
        services.AddSingleton<IFaceAnalysisService, AzureAIFaceAnalysisService>();
        services.AddSingleton<StubFaceAnalysisService>();
        services.AddSingleton<PoMiniGames.Features.PoFace.Storage.IGameSessionRepository, FaceGameSessionRepository>();
        services.AddSingleton<PoMiniGames.Features.PoFace.Storage.ILeaderboardRepository, FaceLeaderboardRepository>();
        services.AddSingleton<PoMiniGames.Features.PoFace.Storage.IPlayerStatsRepository, FacePlayerStatsRepository>();
        // Blob storage for the poface-captures container (round-capture JPEGs).
        // Best-effort: when the blob endpoint is missing or unreachable, the round
        // score is still recorded in table storage and the recap page shows a
        // placeholder image.
        services.AddSingleton<PoMiniGames.Features.PoFace.Storage.IBlobImageRepository, PoMiniGames.Features.PoFace.Storage.BlobImageRepository>();

        // PoJoker — demo-only autonomous comedy show. See Features/PoJoker/.
        // AiJesterService is the production path (shared Azure OpenAI resilience); it
        // falls back to MockAnalysisService in Dev/Test when PoJoker:AzureOpenAI is
        // unconfigured, and throws in Production (StartupSecretValidator fails fast).
        // The joke fetch is a typed HttpClient to JokeAPI.dev with the standard
        // resilience handler; the storage client writes to the PoJokerPerformances
        // table (PartitionKey = SessionId) ensured by StorageInitializer.
        services.AddHttpClient(JokeApiClient.HttpClientName, client =>
            {
                client.Timeout = TimeSpan.FromSeconds(15);
            })
            .AddStandardResilienceHandler();
        services.AddSingleton<IJokeApiClient>(sp => new JokeApiClient(
            sp.GetRequiredService<IHttpClientFactory>().CreateClient(JokeApiClient.HttpClientName),
            sp.GetRequiredService<ILogger<JokeApiClient>>()));
        services.AddSingleton<MockAnalysisService>();
        services.AddSingleton<IAnalysisService, AiJesterService>();
        services.AddSingleton<IJokeStorageClient, JokeStorageClient>();

        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.Converters.Add(
                new System.Text.Json.Serialization.JsonStringEnumConverter());
        });

        return services;
    }
}
