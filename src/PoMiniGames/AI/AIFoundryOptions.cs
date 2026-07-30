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
    /// Returns the deployment name for the supplied game key, falling back to
    /// <see cref="DefaultDeployment"/> when no override is configured. The single resolver for
    /// this question — <c>/api/infer/status</c> and the chat-client construction both go through
    /// it, having previously used different logic and disagreed.
    /// </summary>
    /// <remarks>
    /// Compares case-insensitively over the entries rather than relying on the dictionary's
    /// comparer, because the configuration binder supplies its own instance (ordinal) and there
    /// are at most a handful of games.
    /// </remarks>
    public string ResolveDeployment(string gameKey)
    {
        if (string.IsNullOrWhiteSpace(gameKey))
            return DefaultDeployment;

        foreach (var (key, deployment) in Deployments)
        {
            if (string.Equals(key, gameKey, StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(deployment))
            {
                return deployment;
            }
        }

        return DefaultDeployment;
    }

    /// <summary>True when the endpoint is configured; callers may use this to short-circuit
    /// mock fallback paths in non-Production environments.</summary>
    public bool IsConfigured => !string.IsNullOrWhiteSpace(Endpoint) && !string.IsNullOrWhiteSpace(DefaultDeployment);
}
