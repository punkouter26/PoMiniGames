namespace PoMiniGamesClient.Games.PoSurvive.Store;

using Fluxor;

/// <summary>Immutable state record for the boot sequence.</summary>
[FeatureState]
public sealed record BootState
{
    /// <summary>GPU label shown on boot screen: "ACCELERATED" or "CPU FALLBACK".</summary>
    public string GpuLabel   { get; init; } = "PROBING GPU…";

    /// <summary>Bytes of the model loaded so far (from WebLLM progress callback).</summary>
    public long BytesLoaded  { get; init; } = 0;

    /// <summary>Total model bytes to download (0 means unknown / not started).</summary>
    public long TotalBytes   { get; init; } = 0;

    /// <summary>True once the model is fully loaded (or mock provider is active) and the app can start.</summary>
    public bool IsReady      { get; init; } = false;

    /// <summary>True when the user opted into degraded mode after inference init failed.</summary>
    public bool IsDegradedMode { get; init; } = false;

    /// <summary>True when the mock inference provider is active (triggers "⚠ MOCK DATA" banner).</summary>
    public bool IsMockProvider { get; init; } = false;

    /// <summary>Active provider kind: MOCK | LOCAL | REMOTE.</summary>
    public string ProviderKind { get; init; } = "LOCAL";

    /// <summary>Active model ID used by the currently selected provider.</summary>
    public string ModelId { get; init; } = "";

    /// <summary>Human-readable model label for runtime UI display.</summary>
    public string ModelLabel { get; init; } = "(not set)";

    /// <summary>True when initial model bootstrapping failed and app is running in degraded inference mode.</summary>
    public bool HasInferenceInitError { get; init; } = false;

    /// <summary>Last inference init error message surfaced from JS worker startup.</summary>
    public string? InferenceInitError { get; init; }
}
