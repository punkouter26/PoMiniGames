// filepath: tests/Shared/TestBudgetGuard.cs
namespace PoMiniGames.TestUtilities;

/// <summary>
/// Zero-Waste budget guardrail for the entire automated test suite.
/// Every fixture (Unit harness, Integration <see cref="Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory{TEntryPoint}"/>,
/// E2E-API host, E2E-UI Kestrel host) MUST apply <see cref="Overrides"/> before any HTTP
/// request is served. The intent is structural: even if a developer has live Azure OpenAI
/// keys wired in <c>appsettings.Development.json</c> or <c>dotnet user-secrets</c>, the
/// overrides pin every AI boundary to its in-process mock implementation so the suite can
/// never spend live tokens, accidentally incur a 429, or leak a deployment name.
/// </summary>
/// <remarks>
/// <para><b>§8 Cost-Waste Guardrails — single source of truth.</b> Earlier drafts of the
/// fixtures duplicated the override dictionary inline in
/// <c>TestWebApplicationFactory.ConfigureWebHost</c>, <c>KestrelServerFixture.ConfigureWebHost</c>,
/// and <c>PoMiniGamesE2EFixture.ConfigureWebHost</c>. Drift between those copies was the
/// primary reason <c>IFaceAnalysisService</c> (AzureAIFaceAnalysisService) was missed — only
/// the PoFunQuiz / PoCoupleQuiz overrides existed.</para>
/// <para><b>Pattern:</b> Immutable shared dictionary. Adding a new AI boundary requires
/// exactly one edit here; the next build of any fixture picks it up automatically.</para>
/// </remarks>
public static class TestBudgetGuard
{
    /// <summary>
    /// Required configuration overrides every test host MUST apply before serving traffic.
    /// Keys are case-insensitive; values are written verbatim into an in-memory
    /// <see cref="Microsoft.Extensions.Configuration.IConfigurationProvider"/> stacked ABOVE
    /// <c>appsettings*.json</c>.
    /// </summary>
    public static IReadOnlyDictionary<string, string?> Overrides { get; } = new Dictionary<string, string?>
    {
        // ── Per-game AI mocks ─────────────────────────────────────────────
        // Force the registration switch to true so each game's
        // "if (Features.UseMockAI) AddSingleton<MockX>()" branch wins.
        ["PoFunQuiz:Features:UseMockAI"] = "true",
        ["PoCoupleQuiz:Features:UseMockAI"] = "true",
        ["PoJoker:Features:UseMockAI"] = "true",

        // ── Cloud inference relay ─────────────────────────────────────────
        // PoSurvive's remote model relay; default off in Dev, but a developer's
        // user-secrets may flip it. Pin it off here so neither the integration
        // nor E2E-UI tier can dial Azure OpenAI.
        ["Inference:UseCloudFallback"] = "false",
        ["PoSurvive:Inference:UseCloudFallback"] = "false",

        // ── Browser-side guard ────────────────────────────────────────────
        // FeatureFlags.UseMockData drives the Blazor "USING MOCK DATA" banner.
        // E2E-UI's MockBannerUiTests flips this on via its fixture; everywhere
        // else it stays off so the assertion "banner absent in non-mock
        // environments" is meaningful.
        // (No entry here; the override is conditional per fixture.)
    };

    /// <summary>
    /// Storage connection-string overrides applied alongside <see cref="Overrides"/> when
    /// a fixture provides an Azurite connection string. Mirrors the same value to BOTH the
    /// table-service and blob-service sections so per-game repositories that constructor-
    /// inject <c>BlobServiceClient</c> (e.g. <c>BlobImageRepository</c>) bind to the
    /// emulator instead of falling through to <c>DefaultAzureCredential</c>.
    /// </summary>
    public static IReadOnlyDictionary<string, string?> StorageOverrides(string connectionString, string tableName) =>
        new Dictionary<string, string?>
        {
            ["PoMiniGames:Storage:TableService:ConnectionString"] = connectionString,
            ["PoMiniGames:Storage:BlobService:ConnectionString"] = connectionString,
            ["PoMiniGames:Storage:TableService:TableName"] = tableName,
        };
}