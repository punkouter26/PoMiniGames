using System.Text.Json;
using Azure.Core;
using Microsoft.Extensions.Options;

namespace PoMiniGames.AI;

/// <summary>
/// Startup check that every deployment name in <see cref="AIFoundryOptions.Deployments"/> actually
/// exists on the foundry account.
/// </summary>
/// <remarks>
/// <para>
/// Configuration named <c>gpt-4o-mini</c> for four of five games (and <c>gpt-4o</c> for the fifth)
/// against an account whose only deployments were <c>gpt-5.4-nano</c>, <c>gpt-5-nano</c>,
/// <c>gpt-5.4-mini</c>, <c>Phi-4-mini-instruct</c> and <c>Phi-4</c>. Nothing compared the two, so
/// the mismatch surfaced as a per-call <c>404 DeploymentNotFound</c> at play time — or, worse, was
/// masked entirely when the resolver fell back to the Key Vault default and quietly served a
/// different model than the status endpoint advertised.
/// </para>
/// <para>
/// Uses the data-plane deployment list (<c>GET /openai/deployments</c>) with the same
/// <see cref="TokenCredential"/> the chat client uses, so it needs no control-plane role. A
/// missing name is logged Critical and, in Production, fails startup — the whole point is that a
/// typo cannot reach players. Anything else that goes wrong (network, an account that does not
/// expose the list) is a Warning and never blocks boot: an unverifiable name is not a wrong one.
/// </para>
/// </remarks>
public sealed class FoundryDeploymentValidator : IHostedService
{
    /// <summary>Config flag; defaults to on in Production and off elsewhere.</summary>
    public const string EnabledKey = "PoMiniGames:AI:ValidateDeploymentsOnStartup";

    private const string ListApiVersion = "2023-03-15-preview";
    private static readonly string[] TokenScopes = ["https://cognitiveservices.azure.com/.default"];

    private readonly IOptionsMonitor<AIFoundryOptions> _options;
    private readonly IHostEnvironment _environment;
    private readonly IConfiguration _configuration;
    private readonly ILogger<FoundryDeploymentValidator> _logger;
    private readonly IHttpClientFactory _httpClientFactory;

    public FoundryDeploymentValidator(
        IOptionsMonitor<AIFoundryOptions> options,
        IHostEnvironment environment,
        IConfiguration configuration,
        ILogger<FoundryDeploymentValidator> logger,
        IHttpClientFactory httpClientFactory)
    {
        _options = options;
        _environment = environment;
        _configuration = configuration;
        _logger = logger;
        _httpClientFactory = httpClientFactory;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var opts = _options.CurrentValue;
        var enabled = _configuration.GetValue(EnabledKey, _environment.IsProduction());
        if (!enabled || !opts.IsConfigured)
            return;

        var configured = opts.Deployments
            .Where(kv => !string.IsNullOrWhiteSpace(kv.Value))
            .ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.OrdinalIgnoreCase);
        configured.TryAdd("(default)", opts.DefaultDeployment);

        HashSet<string> available;
        try
        {
            available = await ListDeploymentsAsync(opts.Endpoint, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.DeploymentValidationSkipped(opts.Endpoint, ex.GetType().Name);
            return;
        }

        var missing = configured
            .Where(kv => !available.Contains(kv.Value))
            .ToList();

        if (missing.Count == 0)
        {
            _logger.DeploymentValidationPassed(configured.Count, opts.Endpoint);
            return;
        }

        var availableList = string.Join(", ", available.Order(StringComparer.OrdinalIgnoreCase));
        foreach (var (game, deployment) in missing)
        {
            _logger.DeploymentMissing(deployment, game, opts.Endpoint, availableList);
        }

        if (_environment.IsProduction())
        {
            throw new InvalidOperationException(
                $"AI deployment(s) not present on {opts.Endpoint}: " +
                string.Join(", ", missing.Select(m => $"{m.Key}={m.Value}")) +
                $". Available: {availableList}.");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task<HashSet<string>> ListDeploymentsAsync(string endpoint, CancellationToken ct)
    {
        var credential = new Azure.Identity.DefaultAzureCredential();
        var token = await credential.GetTokenAsync(new TokenRequestContext(TokenScopes), ct);

        using var http = _httpClientFactory.CreateClient(nameof(FoundryDeploymentValidator));
        using var request = new HttpRequestMessage(
            HttpMethod.Get, $"{endpoint.TrimEnd('/')}/openai/deployments?api-version={ListApiVersion}");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token.Token);

        using var response = await http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (doc.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in data.EnumerateArray())
            {
                if (item.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String)
                    names.Add(id.GetString()!);
            }
        }
        return names;
    }
}
