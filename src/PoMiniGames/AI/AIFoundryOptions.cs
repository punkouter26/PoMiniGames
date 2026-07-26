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

    private readonly Dictionary<string, string> _deployments = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Game → deployment allowlist. Resolved from <c>PoMiniGames--AI--Deployments</c> in the form
    /// <c>gameKey=deploymentName,gameKey=deploymentName</c>. Recognised game keys:
    /// <c>couplequiz</c>, <c>funquiz</c>, <c>face</c>, <c>joker</c>, <c>survive</c>.
    /// </summary>
    /// <remarks>
    /// Backed by a field rather than a property so the <see cref="StringComparer.OrdinalIgnoreCase"/>
    /// comparer is preserved across initialisation. Configuration binding populates this via
    /// <see cref="IDictionary{TKey, TValue}.Item"/> rather than a fresh <c>new Dictionary&lt;&gt;()</c>
    /// assignment.
    /// </remarks>
    public IDictionary<string, string> Deployments
    {
        get => _deployments;
        set
        {
            _deployments.Clear();
            if (value is null) return;
            foreach (var kv in value)
            {
                _deployments[kv.Key] = kv.Value;
            }
        }
    }

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
    /// <see cref="DefaultDeployment"/> when no override is configured.
    /// </summary>
    public string ResolveDeployment(string gameKey) =>
        !string.IsNullOrWhiteSpace(gameKey) && Deployments.TryGetValue(gameKey, out var d) && !string.IsNullOrWhiteSpace(d)
            ? d
            : DefaultDeployment;

    /// <summary>True when the endpoint is configured; callers may use this to short-circuit
    /// mock fallback paths in non-Production environments.</summary>
    public bool IsConfigured => !string.IsNullOrWhiteSpace(Endpoint) && !string.IsNullOrWhiteSpace(DefaultDeployment);
}
