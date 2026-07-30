namespace PoMiniGamesClient.Games.PoSurvive.Services;

/// <summary>
/// Opt-in diagnostics correlation for an inference provider: tags the calls made inside the scope
/// with the turn and agent they belong to.
/// </summary>
/// <remarks>
/// This interface exists to fix a silent no-op. The orchestrator opened its scope with
/// <c>(_inference as WebLlmInferenceService)?.BeginDiagnosticsScope(...)</c>, but DI resolves
/// <c>IInferenceService</c> to <see cref="InferenceRouter"/> — so the cast was <c>null</c> on every
/// single call and the in-browser path's per-agent correlation never once activated. Asking for a
/// capability rather than a concrete type means the router can forward to whichever provider is
/// active, and a provider that has no diagnostics simply does not implement it.
/// </remarks>
public interface IInferenceDiagnostics
{
    /// <summary>
    /// Begins a correlation scope for one agent's call. Dispose restores the previous scope.
    /// Returns null when the active provider offers no diagnostics.
    /// </summary>
    IDisposable? BeginDiagnosticsScope(int turnNumber, string agentId, string? team);
}
