namespace PoSurvive.Client.Store;

// ─── Boot sequence actions ────────────────────────────────────────────────────

/// <summary>Dispatched after gpuProbe.js resolves with the GPU availability result.</summary>
public sealed record GpuProbeCompletedAction(
    bool   GpuAvailable,
    string GpuLabel,       // "ACCELERATED" | "CPU FALLBACK"
    bool   IsMockProvider  // True when MockInferenceService is the active IInferenceService
);

/// <summary>Dispatched from the WebLLM progress callback to update the byte-counter.</summary>
public sealed record ModelLoadProgressAction(
    long BytesLoaded,
    long TotalBytes
);

/// <summary>
/// Captures active inference provider metadata for runtime UI indicators.
/// ProviderKind values: MOCK | LOCAL | REMOTE.
/// </summary>
public sealed record InferenceConfiguredAction(
    string ProviderKind,
    string ModelId,
    string ModelLabel
);

/// <summary>
/// Dispatched when the WebLLM worker fails during model initialisation.
/// The UI can use this to indicate degraded inference mode.
/// </summary>
public sealed record InferenceInitFailedAction(string Error);

/// <summary>
/// Dispatched when the user accepts degraded mode after init failure.
/// Sets degraded mode and marks boot as ready so routing can proceed.
/// </summary>
public sealed record ContinueDegradedModeAction;

/// <summary>
/// Clears readiness/error/progress so inference can be re-initialized for a newly selected model.
/// </summary>
public sealed record ResetInferenceBootstrapAction;

/// <summary>
/// Dispatched when the model is fully loaded (or mock provider bypasses loading).
/// Sets IsReady = true which triggers navigation away from the boot screen.
/// </summary>
public sealed record BootReadyAction;
