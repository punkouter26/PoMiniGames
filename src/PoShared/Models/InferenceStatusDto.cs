namespace PoShared.Simulation.Models;

/// <summary>
/// What <c>GET /api/infer/status</c> tells the browser about the server-side inference relay.
///
/// This endpoint exists because the client had no way to find out. The model picker was
/// populated purely from the WASM app's own <c>Inference:RemoteModelOptions</c>, which listed
/// <c>gpt-5.4-nano</c> while the server's allowlist held <c>gpt-4o-mini</c>/<c>gpt-4o</c> — so
/// the one remote id the UI could offer was an id the relay did not serve. Worse, nothing
/// consulted the relay at all before deciding the session was degraded, which is how every
/// battle ended up running on the local fallback table.
///
/// The server is the authority on both questions ("is the relay on?" and "which deployment
/// serves PoSurvive?"), so it answers them directly.
/// </summary>
/// <param name="Available">
/// True when <c>Inference:UseCloudFallback</c> is on AND a chat client actually resolved.
/// A false here is the signal to fall back to the in-browser model rather than to guess.
/// </param>
/// <param name="ModelId">
/// The single deployment the relay is bound to. The shared <c>IChatClient</c> is created per
/// game key, so per-request model switching is not available — advertising one honest id
/// beats offering a menu the relay ignores.
/// </param>
/// <param name="Label">Human-readable name for the model picker.</param>
public sealed record InferenceStatusDto(
    bool Available,
    string ModelId,
    string Label
);
