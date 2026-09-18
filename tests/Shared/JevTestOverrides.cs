// filepath: tests/Shared/JevTestOverrides.cs
namespace PoMiniGames.TestUtilities;

/// <summary>
/// Configuration overrides that pin <see cref="JevOptions"/> to a non-functional
/// state across every test fixture, so no test can spend live tokens on Jev
/// even when a developer has wired a real <c>OpenRouter</c> key into
/// <c>appsettings.Development.json</c>.
///
/// <para>
/// <b>Drift warning.</b> <see cref="TestBudgetGuard.Overrides"/> is the canonical
/// source of truth for AI mocking. Jev deliberately lives in its own helper
/// (instead of being folded into <see cref="TestBudgetGuard.Overrides"/>) because
/// the fixtures here do not all need to inject an <c>IJevClient</c> stub — only
/// the Integration / E2E-API hosts do. The Unit harness short-circuits via the
/// <c>IsConfigured</c> check; these overrides exist so that when a stub IS
/// injected, the keyed config still resolves consistently across hosts.
/// </para>
/// </summary>
public static class JevTestOverrides
{
    public const string StubKey = "test-stub-not-a-real-key";

    public static IReadOnlyDictionary<string, string?> Overrides { get; } = new Dictionary<string, string?>
    {
        ["PoMiniGames:Jev:ApiKey"] = StubKey,
        ["PoMiniGames:Jev:Provider"] = "stub",
        ["PoMiniGames:Jev:Model"] = "stub/jev",
        ["PoMiniGames:Jev:DailyDecisionsPerIdentity"] = "0",
        ["PoMiniGames:Jev:CallTimeoutMs"] = "10",
    };
}
