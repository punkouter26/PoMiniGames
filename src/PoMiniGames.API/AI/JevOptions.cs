// filepath: src/PoMiniGames.API/AI/JevOptions.cs
namespace PoMiniGames.AI;

/// <summary>
/// Configuration for the Jev decision client. Resolved from Key Vault
/// (<c>PoMiniGames--Jev--*</c>) the same way <see cref="AIFoundryOptions"/> is.
///
/// <para><b>Why a separate section?</b> Jev is a different surface from the chat
/// pipeline: it does not consume deployments, has no per-call token ceiling, and
/// does not share resilience pipelines. Keeping it under its own <c>PoMiniGames:Jev</c>
/// root means the chat path stays unchanged and Jev-specific knobs (the
/// per-identity daily decision cap, the call timeout) live here.</para>
/// </summary>
public sealed class JevOptions
{
    public const string SectionName = "PoMiniGames:Jev";

    /// <summary>Provider discriminator. <c>openrouter</c> for hosted TypeSafe via OpenRouter.</summary>
    public string Provider { get; set; } = "openrouter";

    /// <summary>HTTP endpoint HOST ROOT for the Jev decision client. The relative path
    /// (<c>api/alpha/decisions</c>) is appended in <see cref="JevHttpClient"/>. Default
    /// points at OpenRouter, which hosts <c>typesafe/jev-1.13</c> under that path.
    /// </summary>
    public string Endpoint { get; set; } = "https://openrouter.ai";

    /// <summary>Model id under that provider. <c>typesafe/jev-1.13</c> is the pinned SKU.</summary>
    public string Model { get; set; } = "typesafe/jev-1.13";

    /// <summary>Bearer token. Resolved from Key Vault secret <c>PoMiniGames--Jev--ApiKey</c>.</summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Per-identity daily decision cap. Defaults to 2 000 — at 2 K input tokens
    /// each, that's $0.168 / day / identity at full saturation. The
    /// <see cref="AI.AiTokenBudget"/> already caps the *chat* spend at 250 K
    /// tokens / day; this caps the *Jev* spend, separately.
    /// </summary>
    public int DailyDecisionsPerIdentity { get; set; } = 2000;

    /// <summary>
    /// Per-call HTTP timeout (ms). Jev is supposed to be 70-300 ms; 1 500 ms
    /// gives the upstream headroom without making a flaky Jev hold up the
    /// caller's main request thread.
    /// </summary>
    public int CallTimeoutMs { get; set; } = 1500;

    /// <summary>
    /// <c>true</c> when <see cref="ApiKey"/> is non-empty and a provider is
    /// selected. Mirrors the <see cref="AIFoundryOptions.IsConfigured"/> pattern
    /// so callers can short-circuit when the key is absent.
    /// </summary>
    public bool IsConfigured => !string.IsNullOrWhiteSpace(ApiKey) && !string.IsNullOrWhiteSpace(Provider);
}
