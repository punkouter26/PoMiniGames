namespace PoMiniGames.AI;

/// <summary>
/// Centralized Azure AI Foundry binding used by every AI-consuming service in the host.
/// <para>
/// Replaces the per-game configuration sections (<c>PoFunQuiz:AzureOpenAI:*</c>,
/// <c>PoCoupleQuiz:AzureOpenAI:*</c>, <c>PoJoker:AzureOpenAI:*</c>,
/// and <c>Inference:*</c>) with a single source-of-truth resolved at startup from Key Vault.
/// </para>
/// <para>
/// <b>Configuration contract</b> (resolved by <see cref="Microsoft.Extensions.Configuration.KeyVaultConfigurationProvider"/>
/// via <see cref="Azure.Extensions.AspNetCore.Configuration.Secrets.KeyVaultSecretManager"/>):
/// <list type="bullet">
///   <item><c>PoMiniGames--AI--FoundryEndpoint</c> → <see cref="Endpoint"/> (no trailing slash)</item>
///   <item><c>PoMiniGames--AI--DefaultDeployment</c> → <see cref="DefaultDeployment"/></item>
///   <item><c>PoMiniGames--AI--Deployments</c> → comma-separated <c>game:deploymentName</c> pairs</item>
/// </list>
/// </para>
/// </summary>
/// <remarks>
/// SOLID: Single Responsibility — this class is a pure DTO bound from configuration.
/// </remarks>
public sealed class AIFoundryOptions
{
    /// <summary>Configuration root section name. Use <see cref="SectionName"/> in all callers.</summary>
    public const string SectionName = "PoMiniGames:AI";

    /// <summary>
    /// Azure AI Foundry account endpoint. Example:
    /// <c>https://cog-pominigames-xxxxxxxx.openai.azure.com</c>. Resolved from Key Vault
    /// secret <c>PoMiniGames--AI--FoundryEndpoint</c>.
    /// </summary>
    public string Endpoint { get; set; } = string.Empty;

    /// <summary>Default deployment name used when no per-game deployment is configured.</summary>
    public string DefaultDeployment { get; set; } = "gpt-4o-mini";

    /// <summary>
    /// Game → deployment allowlist. Recognised game keys: <c>couplequiz</c>, <c>funquiz</c>,
    /// <c>face</c>, <c>joker</c>, <c>survive</c>. Populated either from a nested configuration
    /// section (<c>PoMiniGames:AI:Deployments:survive</c>) or from the flat Key Vault secret
    /// <c>PoMiniGames--AI--Deployments</c> in the form <c>game=deployment,game=deployment</c>
    /// (parsed in <c>GameServicesExtensions</c>).
    /// </summary>
    /// <remarks>
    /// <para>
    /// This was an <see cref="IDictionary{TKey, TValue}"/> property over a readonly
    /// <see cref="StringComparer.OrdinalIgnoreCase"/> field, on the documented assumption that
    /// the configuration binder would populate the existing instance through the indexer and so
    /// preserve the comparer. It does not — measured 2026-07-29, with
    /// <c>PoMiniGames:AI:Deployments:survive = gpt-5.4-nano</c> present in configuration,
    /// <see cref="ResolveDeployment"/> still returned <see cref="DefaultDeployment"/>. Nothing
    /// failed loudly: <em>every</em> game silently ran on the Key Vault default deployment while
    /// <c>/api/infer/status</c> reported the per-game name from a separate raw-config read, so the
    /// two answers to "which model serves this game?" disagreed in production.
    /// </para>
    /// <para>
    /// A plain settable <see cref="Dictionary{TKey, TValue}"/> is the shape the binder handles
    /// reliably; the comparer is therefore no longer guaranteed, and
    /// <see cref="ResolveDeployment"/> compares case-insensitively itself rather than trusting it.
    /// </para>
    /// </remarks>
    public Dictionary<string, string> Deployments { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Deployment serving embedding requests, or empty when the account has none. Resolved from
    /// <c>PoMiniGames--AI--EmbeddingDeployment</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Optional on purpose. PoCoupleQuiz's answer-similarity scoring prefers embeddings — one float
    /// is an absurd thing to spend a chat completion on, and cosine over two vectors is both
    /// cheaper by orders of magnitude and deterministic, which makes it permanently cacheable
    /// rather than cacheable-until-the-model-drifts.
    /// </para>
    /// <para>
    /// But the deployment inventory verified on the shared account (2026-07-29) lists only
    /// <c>gpt-5.4-nano</c>, <c>gpt-5-nano</c>, <c>gpt-5.4-mini</c>, <c>Phi-4-mini-instruct</c> and
    /// <c>Phi-4</c> — <b>no embedding model</b>. So this is left empty by default and the scorer
    /// falls back to the chat path when it is. Deploy <c>text-embedding-3-small</c> and set this to
    /// switch the cheaper path on; nothing else has to change.
    /// </para>
    /// </remarks>
    public string EmbeddingDeployment { get; set; } = string.Empty;

    /// <summary>
    /// Deployment name → capability profile, overriding the name heuristic in
    /// <see cref="AiModelCapabilities"/>. Recognised profiles: <c>reasoning</c>,
    /// <c>conventional</c>, <c>basic</c>.
    /// </summary>
    /// <remarks>
    /// The heuristic reads the deployment name, which is inference rather than fact — a deployment
    /// can be called anything. This is the escape hatch for an account whose names do not describe
    /// what they serve, and the safe way to correct a wrong guess without a code change.
    /// </remarks>
    public Dictionary<string, string> ModelCapabilityOverrides { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Game keys recognised in <see cref="Deployments"/>.</summary>
    public static class Games
    {
        public const string CoupleQuiz = "couplequiz";
        public const string FunQuiz = "funquiz";
        public const string Face = "face";
        public const string Joker = "joker";
        public const string Survive = "survive";
    }

    /// <summary>
    /// Task keys, appended to a game key as <c>game.task</c> to give one task inside a game its own
    /// deployment.
    /// </summary>
    /// <remarks>
    /// Model choice is per game, but cost is per task, and inside a single game the tasks are not
    /// remotely alike. PoJoker asks a model to invent a punchline (wants a capable model) and, in
    /// the same breath, to emit three numbers between 0 and 1 (wants the cheapest thing that can
    /// count). Pinning both to one deployment means paying the harder task's rate for the easier
    /// one on every joke.
    /// </remarks>
    public static class Tasks
    {
        /// <summary>PoJoker: scoring a joke's originality/cleverness/humour.</summary>
        public const string JokerRating = "joker.rating";

        /// <summary>PoJoker: rewriting a flagged joke.</summary>
        public const string JokerRewrite = "joker.rewrite";

        /// <summary>PoCoupleQuiz: scoring similarity between two answers (chat fallback path).</summary>
        public const string CoupleQuizSimilarity = "couplequiz.similarity";
    }

    /// <summary>
    /// Returns the deployment name for the supplied game key, falling back to
    /// <see cref="DefaultDeployment"/> when no override is configured. The single resolver for
    /// this question — <c>/api/infer/status</c> and the chat-client construction both go through
    /// it, having previously used different logic and disagreed.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Compares case-insensitively over the entries rather than relying on the dictionary's
    /// comparer, because the configuration binder supplies its own instance (ordinal) and there
    /// are at most a handful of games.
    /// </para>
    /// <para>
    /// A key of the form <c>game.task</c> (see <see cref="Tasks"/>) resolves in two steps: the full
    /// task key first, then the bare game key, then the default. That ordering is what lets a task
    /// override be added or removed in configuration alone, with the game's own entry as the
    /// standing answer — and it means an unconfigured task never resolves to something surprising,
    /// it resolves to whatever its game already used.
    /// </para>
    /// </remarks>
    public string ResolveDeployment(string gameKey)
    {
        if (string.IsNullOrWhiteSpace(gameKey))
            return DefaultDeployment;

        if (Lookup(gameKey) is { } exact)
            return exact;

        // "joker.rating" with no entry of its own falls back to "joker" before the global default.
        var dot = gameKey.IndexOf('.');
        if (dot > 0 && Lookup(gameKey[..dot]) is { } game)
            return game;

        return DefaultDeployment;

        string? Lookup(string key)
        {
            foreach (var (candidate, deployment) in Deployments)
            {
                if (string.Equals(candidate, key, StringComparison.OrdinalIgnoreCase)
                    && !string.IsNullOrWhiteSpace(deployment))
                {
                    return deployment;
                }
            }
            return null;
        }
    }

    /// <summary>True when the endpoint is configured; callers may use this to short-circuit
    /// mock fallback paths in non-Production environments.</summary>
    public bool IsConfigured => !string.IsNullOrWhiteSpace(Endpoint) && !string.IsNullOrWhiteSpace(DefaultDeployment);
}
