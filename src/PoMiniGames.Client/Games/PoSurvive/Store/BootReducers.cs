namespace PoSurvive.Client.Store;

using Fluxor;

// ─── Boot reducers ────────────────────────────────────────────────────────────
// All reducers are pure functions: they never mutate state, only produce new records.

public static class BootReducers
{
    [ReducerMethod]
    public static BootState OnGpuProbeCompleted(BootState state, GpuProbeCompletedAction action)
        => state with
        {
            GpuLabel      = action.GpuLabel,
            IsMockProvider = action.IsMockProvider,
        };

    [ReducerMethod]
    public static BootState OnModelLoadProgress(BootState state, ModelLoadProgressAction action)
        => state with
        {
            BytesLoaded = action.BytesLoaded,
            TotalBytes  = action.TotalBytes,
        };

    [ReducerMethod]
    public static BootState OnInferenceConfigured(BootState state, InferenceConfiguredAction action)
        => state with
        {
            ProviderKind = action.ProviderKind,
            ModelId      = action.ModelId,
            ModelLabel   = action.ModelLabel,
        };

    [ReducerMethod]
    public static BootState OnInferenceInitFailed(BootState state, InferenceInitFailedAction action)
        => state with
        {
            HasInferenceInitError = true,
            InferenceInitError    = action.Error,
        };

    [ReducerMethod]
    public static BootState OnContinueDegradedMode(BootState state, ContinueDegradedModeAction _)
        => state with
        {
            IsDegradedMode = true,
            IsReady = true,
        };

    [ReducerMethod]
    public static BootState OnResetInferenceBootstrap(BootState state, ResetInferenceBootstrapAction _)
        => state with
        {
            BytesLoaded = 0,
            TotalBytes = 0,
            IsReady = false,
            IsDegradedMode = false,
            HasInferenceInitError = false,
            InferenceInitError = null,
        };

    [ReducerMethod]
    public static BootState OnBootReady(BootState state, BootReadyAction _)
        => state with { IsReady = true };
}
