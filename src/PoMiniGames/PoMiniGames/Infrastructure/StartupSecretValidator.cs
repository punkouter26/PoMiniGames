using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Hosting;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Hosted service that runs once at startup and validates that the secrets required for every
/// consolidated game (PoCoupleQuiz, PoFunQuiz, PoFace) are present. This is the fail-fast
/// guard so a misconfigured production deployment never silently serves mock/fallback data
/// to real players.
///
/// <para><b>Behavior by environment</b>:</para>
/// <list type="bullet">
///   <item><b>Production</b> — throws <see cref="InvalidOperationException"/> if any required
///         secret is missing or empty. Prevents the app from accepting traffic with a
///         half-configured Azure OpenAI client that would degrade to mock data on every call.</item>
///   <item><b>Development</b> — logs a warning and continues so local dev iteration is not
///         blocked by missing secrets.</item>
///   <item><b>Test</b> — skips validation; tests intentionally use mock services.</item>
/// </list>
/// <para>Pattern: Fail-Fast. The service runs as <see cref="IHostedService"/> before the first
/// HTTP request is processed.</para>
/// </summary>
/// <remarks>Lifted from PoFunQuiz's StartupSecretValidator (2026-06-13 mock-data fix). The
/// per-game secret sections are optional; a missing section is treated the same as an empty
/// value. Per-game gating lets a deployment enable only one of the three games.</remarks>
public sealed class StartupSecretValidator : IHostedService
{
    /// <summary>Per-game configuration section names. The validator only enforces a section
    /// that is *present* (even if empty) — that is the operator's signal that they intend to
    /// host the game and are ready to provide the keys.</summary>
    public static readonly IReadOnlyList<string> GameSections = new[]
    {
        "PoCoupleQuiz:AzureOpenAI",
        "PoFunQuiz:AzureOpenAI",
        "PoFace:AzureOpenAI",
        "PoJoker:AzureOpenAI",
    };

    private readonly IHostEnvironment _environment;
    private readonly IConfiguration _configuration;
    private readonly ILogger<StartupSecretValidator> _logger;
    private readonly IAuthenticationSchemeProvider _schemeProvider;

    public StartupSecretValidator(
        IHostEnvironment environment,
        IConfiguration configuration,
        ILogger<StartupSecretValidator> logger,
        IAuthenticationSchemeProvider schemeProvider)
    {
        _environment = environment;
        _configuration = configuration;
        _logger = logger;
        _schemeProvider = schemeProvider;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        // ── Production compilation guard ─────────────────────────────
        // The FakeAuth scheme bypasses real identity and must never be live in Production.
        // Fail fast (unhandled) if it is registered while running as Production, regardless
        // of how it got there.
        if (_environment.IsProduction())
        {
            var fakeScheme = await _schemeProvider.GetSchemeAsync(FakeAuthHandler.SchemeName);
            if (fakeScheme is not null)
            {
                throw new InvalidOperationException(
                    $"FATAL: authentication scheme '{FakeAuthHandler.SchemeName}' is registered while running in " +
                    "Production. Fake authentication must never be enabled in Production.");
            }
        }

        // Test environment uses mock services (registered by feature-specific wiring) — skip.
        if (_environment.IsEnvironment("Test"))
        {
            _logger.LogInformation("Startup secret validation skipped in Test environment");
            return;
        }

        var missing = new List<string>();

        foreach (var sectionPath in GameSections)
        {
            var section = _configuration.GetSection(sectionPath);
            if (!section.Exists())
            {
                // Operator chose not to enable this game. Not an error.
                continue;
            }

            var endpoint = section["Endpoint"];
            var apiKey = section["ApiKey"];
            var deploymentName = section["DeploymentName"];

            if (string.IsNullOrWhiteSpace(endpoint))
                missing.Add($"{sectionPath}:Endpoint");
            if (string.IsNullOrWhiteSpace(apiKey))
                missing.Add($"{sectionPath}:ApiKey");
            if (string.IsNullOrWhiteSpace(deploymentName))
                missing.Add($"{sectionPath}:DeploymentName");
        }

        if (missing.Count == 0)
        {
            _logger.LogInformation(
                "Startup secret validation passed for {Environment}",
                _environment.EnvironmentName);
            return;
        }

        var joined = string.Join(", ", missing);
        var message = $"Required secrets are missing for environment '{_environment.EnvironmentName}': {joined}";

        if (_environment.IsProduction())
        {
            // Fail fast in Production — a misconfigured deployment must not start and
            // silently serve fabricated fallback data to real players.
            // Static template (CA2254): never vary the format string between calls.
            _logger.LogCritical(
                "Required secrets are missing for environment {Environment}: {Missing}. " +
                "The application will NOT start. Configure these secrets via Azure Key Vault " +
                "(kv-poshared) under the PoMiniGames--<Game>--AzureOpenAI--* secret names. {Message}",
                _environment.EnvironmentName,
                joined,
                message);
            throw new InvalidOperationException(message);
        }

        // In Development: warn loud but keep running so local dev iteration is not blocked.
        _logger.LogWarning(
            "Required secrets are missing for environment {Environment}: {Missing}. " +
            "Continuing in {Environment} because non-Production environments are allowed to " +
            "run with missing secrets. The relevant games will refuse to serve AI requests " +
            "until the keys are set. {Message}",
            _environment.EnvironmentName,
            joined,
            _environment.EnvironmentName,
            message);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
