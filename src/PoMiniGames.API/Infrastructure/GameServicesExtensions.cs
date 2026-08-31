using PoMiniGames.Domain.Services;
using PoMiniGames.Features.PoCoupleQuiz;
using PoMiniGames.Features.PoFunQuiz;
using PoMiniGames.Features.PoFunQuiz.Storage;
using PoMiniGames.Features.PoJoker;
using PoMiniGames.Features.PoJoker.Storage;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Infrastructure.Services;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Registers all game-specific services used by the local-only app.
/// </summary>
internal static class GameServicesExtensions
{
    public static IServiceCollection AddPoMiniGamesGameServices(this IServiceCollection services)
    {
        // ─── Centralized Azure AI Foundry hub (PoShared RG) ─────────────────
        // One shared AzureOpenAIClient + per-deployment ChatClient cache. Every
        // game that needs an AI model resolves through AIFoundryChatClientCache
        // with its game key (couplequiz, funquiz, face, joker, survive).
        // Replaces the legacy per-game PoFunQuiz:AzureOpenAI, PoCoupleQuiz:AzureOpenAI,
        // PoFace:AzureOpenAI, PoJoker:AzureOpenAI, Inference:* sections.
        services.AddOptions<AIFoundryOptions>()
            // Bind the configuration section the Key Vault secrets land in. This was missing:
            // the options object was built ONLY from the environment-variable overrides below,
            // so a correctly-populated kv-poshared (PoMiniGames--AI--*) left Endpoint empty,
            // IsConfigured false, and every AI-backed game silently served mock data.
            .BindConfiguration(AIFoundryOptions.SectionName)
            .PostConfigure<IConfiguration>((opts, configuration) =>
            {
                // The vault names the endpoint secret PoMiniGames--AI--FoundryEndpoint, which
                // binds to "<section>:FoundryEndpoint" — not to the Endpoint property. Map it
                // across rather than renaming the secret, which other apps also read.
                // Host environment variables stay the local override, and each only applies when
                // actually set: unconditionally assigning DefaultDeployment used to stamp
                // "gpt-4o-mini" over whatever the vault said.
                var endpoint = Environment.GetEnvironmentVariable("PoMiniGames__AI__FoundryEndpoint")
                    ?? configuration[$"{AIFoundryOptions.SectionName}:FoundryEndpoint"];
                if (!string.IsNullOrWhiteSpace(endpoint))
                {
                    opts.Endpoint = endpoint!;
                }

                var defaultDeployment = Environment.GetEnvironmentVariable("PoMiniGames__AI__DefaultDeployment");
                if (!string.IsNullOrWhiteSpace(defaultDeployment))
                {
                    opts.DefaultDeployment = defaultDeployment!;
                }

                // The vault stores the per-game map as ONE secret — PoMiniGames--AI--Deployments,
                // "game=deployment,game=deployment" — which arrives as a scalar value at
                // "<section>:Deployments" and cannot bind to a dictionary at all. Parsed here so
                // the flat and nested forms produce the same options object; nested keys already
                // bound above are kept, with the flat form filling gaps rather than overwriting.
                var flat = Environment.GetEnvironmentVariable("PoMiniGames__AI__Deployments")
                    ?? configuration[$"{AIFoundryOptions.SectionName}:Deployments"];
                foreach (var (game, deployment) in ParseDeploymentPairs(flat))
                {
                    if (!opts.Deployments.Any(kv => string.Equals(kv.Key, game, StringComparison.OrdinalIgnoreCase)))
                        opts.Deployments[game] = deployment;
                }
            });
        services.AddSingleton<AIFoundryClientFactory>();
        services.AddSingleton<AIFoundryChatClientCache>();
        // §3: register the resilience pipeline (retry + circuit breaker + outer timeout)
        // used by every AI Foundry consumer. Idempotent — safe to call multiple times.
        // Consumed by ResilientChatClient, which every keyed game chat client is wrapped in;
        // for a long while it was registered here and resolved nowhere, so a single call could
        // (and did) run 51.6 s against its own documented 20 s ceiling.
        services.AddAzureOpenAIResilience();
        // Cross-cutting AI concerns: usage/latency read-model, per-identity spend ceiling, and a
        // startup check that every configured deployment name exists on the account.
        services.AddSingleton<AiUsageAccumulator>();
        services.AddOptions<AiTokenBudgetOptions>().BindConfiguration(AiTokenBudgetOptions.SectionName);
        services.AddSingleton<AiTokenBudget>();
        // Memoizes per-(game, deployment) ChatOptions so the JSON-element cloning and the
        // raw-representation factory allocation happen once per pair rather than once per call.
        // Pure-local hot-path win; no network effect. Registered as the interface too so the
        // game services that inject IAiDecisionOptionsCache resolve the same singleton.
        services.AddSingleton<AiDecisionOptionsCache>();
        services.AddSingleton<IAiDecisionOptionsCache>(sp => sp.GetRequiredService<AiDecisionOptionsCache>());
        // Embeddings for the similarity-scoring path. Dormant unless
        // PoMiniGames:AI:EmbeddingDeployment names a deployment — the shared account currently has
        // none, so PoCoupleQuiz still scores via chat; see AiEmbeddingService.
        services.AddSingleton<AiEmbeddingService>();
        services.AddHttpClient(nameof(FoundryDeploymentValidator), client =>
        {
            client.Timeout = TimeSpan.FromSeconds(10);
        });
        services.AddHostedService<FoundryDeploymentValidator>();
        // Keeps the default deployment warm with one minimal call every 30 minutes, so the
        // first player-facing AI interaction of a cold period pays steady-state latency rather
        // than the cold-start penalty. Idles silently when the foundry is unconfigured.
        services.AddHostedService<AiWarmupService>();
        // Every AI-consuming slice now resolves its chat client through GameChatClientFactory, so
        // each gets the resilience pipeline, the spend ceiling and the telemetry by construction.
        // Registering the keys here (rather than in each slice) keeps the set in one place and
        // makes the health-tracker keys predictable. Idempotent — PoSurvive registers its own too.
        services.AddGameChatClient(AIFoundryOptions.Games.CoupleQuiz);
        services.AddGameChatClient(AIFoundryOptions.Games.FunQuiz);
        services.AddGameChatClient(AIFoundryOptions.Games.Joker);
        // /health gains an AI check, and /api/health/ai exposes the usage read-model that
        // AiUsageAccumulator has been filling with no reader.
        services.AddHealthChecks()
            .AddCheck<AiFoundryHealthCheck>(
                "AiFoundry",
                tags: ["ai", "ready"]);
        // PoRaceRagdoll feature removed.

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
        // Head-to-head ratings for the PoBrawl demo board. A distinct calculator with its own
        // options section, not a mode of EloCalculator — see PairwiseEloCalculator's remarks
        // for why the two cannot merge.
        // BindConfiguration rather than Configure(section): this extension takes no
        // IConfiguration, and resolving it from DI keeps the signature unchanged.
        services.AddOptions<PairwiseEloOptions>().BindConfiguration(PairwiseEloOptions.SectionName);
        services.AddSingleton(sp =>
        {
            var config = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<PairwiseEloOptions>>();
            return new PairwiseEloCalculator(config.Value);
        });

        // Storage initializer for the consolidated games (PoCoupleQuiz, PoFunQuiz).
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
        // The round timer lives in CoupleQuizRoundDirector below.
        // Every consumer injects IGameSessionManager; nothing resolves the concrete type, so
        // the previous concrete-forwarding registration was dead and has been removed.
        services.AddSingleton<IQuestionService, AiQuestionService>();
        services.AddSingleton<MockQuestionService>();
        // Owns the round clock. A Hub instance lives for one invocation and cannot hold a
        // timer, so rounds are driven from this singleton over a long-lived IHubContext.
        services.AddSingleton<CoupleQuizRoundDirector>();

        // PoFunQuiz — Phase 2 of the consolidation. See Features/PoFunQuiz/.
        // AiQuizGeneratorService is the production path; mock fallback is gated to Dev/Test
        // inside the service. The leaderboard repository writes to the
        // PoFunQuizPlayers table (PartitionKey = Category, RowKey = Guid).
        // MultiplayerLobbyService is the in-memory registry for the SignalR hub
        // (CreateGame/JoinGame/StartGame/UpdateScore/PlayerFinished).
        // §3.4 HybridCache: stampede-protected memoization for deterministic, expensive
        // Azure OpenAI calls (answer-similarity scoring + question generation).
        // Shared by PoCoupleQuiz (answer similarity) and PoFunQuiz (question list).
        services.AddHybridCache();
        services.AddSingleton<IOpenAIService, AiQuizGeneratorService>();
        services.AddSingleton<PoMiniGames.Features.PoFunQuiz.Storage.ILeaderboardRepository,
            PoMiniGames.Features.PoFunQuiz.Storage.LeaderboardRepository>();
        services.AddSingleton<MultiplayerLobbyService>();

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
        // Rewrites flagged jokes so the Jester performs a clean version instead of
        // skipping them. Deliberately has no mock stand-in: a fabricated rewrite
        // would report a joke as cleaned when it was not.
        services.AddSingleton<IJokeRewriteService, JokeRewriteService>();
        services.AddSingleton<IJokeStorageClient, JokeStorageClient>();

        // PoRacer — multiplayer racing. The lobby service is the in-memory
        // registry; the race registry + service own the per-game simulation
        // timer. Both are process-local (single-instance, like every other
        // multiplayer lobby in the host) and are DI-managed so the host's
        // graceful-shutdown path can dispose the race registry.
        services.AddSingleton<PoMiniGames.Features.PoRacer.PoRacerLobbyService>();
        services.AddSingleton<PoMiniGames.Features.PoRacer.PoRacerRaceRegistry>();

        // PoSports — family track meet. Same single-lobby process-local shape as
        // PoRacer; the registry owns the meet sim timers and is DI-managed for
        // graceful-shutdown disposal.
        services.AddSingleton<PoMiniGames.Features.PoSports.PoSportsLobbyService>();
        services.AddSingleton<PoMiniGames.Features.PoSports.PoSportsRaceRegistry>();

        // PoVoxelStrike — startup GLB → voxel ingestion plus the in-memory asset catalog
        // the manifest/payload endpoints read. See Features/PoVoxelStrike/.
        services.AddOptions<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeOptions>()
            .BindConfiguration(PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeOptions.SectionName);
        services.AddSingleton<PoMiniGames.Features.PoVoxelStrike.VoxelAssetCatalog>();
        services.AddHostedService<PoMiniGames.Features.PoVoxelStrike.AssetIngestionHostedService>();
        // PoVoxelStrike co-op: same single-lobby process-local shape as PoRacer/PoFunQuiz.
        // The lobby service is the in-memory registry; the lockstep service owns the
        // per-game input batching; the pump broadcasts frames on a drift-corrected
        // 50 ms timer (host-independent — survives host websocket reconnects).
        services.AddSingleton<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLobbyService>();
        services.AddSingleton<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLockstepService>();
        services.AddHostedService<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLockstepPump>();

        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.Converters.Add(
                new System.Text.Json.Serialization.JsonStringEnumConverter());
        });

        return services;
    }

    /// <summary>
    /// Parses the flat <c>game=deployment,game=deployment</c> form of the per-game deployment map.
    /// Accepts <c>:</c> as the separator too, which is how the secret is documented.
    /// </summary>
    private static IEnumerable<(string Game, string Deployment)> ParseDeploymentPairs(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            yield break;

        foreach (var pair in raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var split = pair.IndexOfAny(['=', ':']);
            if (split <= 0 || split == pair.Length - 1)
                continue;

            var game = pair[..split].Trim();
            var deployment = pair[(split + 1)..].Trim();
            if (game.Length > 0 && deployment.Length > 0)
                yield return (game, deployment);
        }
    }
}
