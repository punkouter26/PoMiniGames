namespace PoMiniGames.Features.PoJevArena.Jev;

/// <summary>
/// Configuration for TypeSafe's Jev decision model, bound from <c>PoMiniGames:Jev</c>. The key is a
/// Key Vault secret (<c>PoMiniGames--Jev--ApiKey</c>) in deployed environments and a local-only
/// <c>appsettings.Development.json</c> value otherwise — never committed, never user-secrets.
/// </summary>
/// <remarks>
/// Jev is <b>required</b> by PoJevArena: with no key the arena reports itself unavailable rather
/// than inventing decisions. <see cref="UseStub"/> exists for the test hosts only and is honoured
/// solely under the <c>Test</c> environment (see <c>tests/Shared/TestBudgetGuard.cs</c>).
/// </remarks>
public sealed class JevOptions
{
    public const string SectionName = "PoMiniGames:Jev";

    /// <summary>OpenRouter API root; <see cref="Path"/> is appended. Keep the trailing slash.</summary>
    public string Endpoint { get; set; } = "https://openrouter.ai/api/v1/";

    /// <summary>
    /// The System One route (SDK-compatible, not marked alpha). The older
    /// <c>../alpha/decisions</c> route takes the same body if this ever needs to change.
    /// </summary>
    public string Path { get; set; } = "systemone";

    /// <summary>Pinned rather than <c>jev-latest</c> so calibration does not shift under the game.</summary>
    public string Model { get; set; } = "typesafe/jev-1.13";

    public string ApiKey { get; set; } = string.Empty;

    /// <summary>A decision that lands after the unit's next 1 Hz slot is worthless, so no retries.</summary>
    public int CallTimeoutMs { get; set; } = 1500;

    /// <summary>Process-wide in-flight cap; OpenRouter's Jev rate limit is not published.</summary>
    public int MaxConcurrentCalls { get; set; } = 16;

    /// <summary>Per identity per UTC day; one 3-minute match is ~3,600 calls.</summary>
    public long DailyCallsPerIdentity { get; set; } = 20_000;

    /// <summary>Test hosts only; ignored outside the <c>Test</c> environment.</summary>
    public bool UseStub { get; set; }

    public bool IsConfigured => !string.IsNullOrWhiteSpace(ApiKey) && !string.IsNullOrWhiteSpace(Endpoint);
}
