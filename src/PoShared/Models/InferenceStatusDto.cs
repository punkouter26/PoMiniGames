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
/// The server is the authority on all three questions ("is the relay on?", "which deployment
/// serves PoSurvive by default?" and "which other ids will it accept?"), so it answers them
/// directly.
/// </summary>
/// <param name="Available">
/// True when <c>Inference:UseCloudFallback</c> is on AND a chat client actually resolved.
/// A false here is the signal to fall back to the in-browser model rather than to guess.
/// </param>
/// <param name="ModelId">
/// The deployment the relay binds to when a request names no model. Still the default, and
/// still what the provider chip reports before the player picks anything.
/// </param>
/// <param name="Label">Human-readable name for the model picker.</param>
/// <param name="Models">
/// Every id the relay will serve, from the server-side <c>Inference:RemoteModelOptions</c>
/// allowlist that <c>InferRequestDto.ModelId</c> is validated against.
///
/// This used to be absent, and the doc here claimed per-request switching did not exist —
/// which had stopped being true: <c>PoSurviveServiceExtensions</c> resolves a distinct cached
/// chat client per allowlisted id. The picker's whole "Cloud" group was therefore a list of
/// one, on a shared account configured with three. Empty means the server has no allowlist
/// and only <see cref="ModelId"/> is addressable.
/// </param>
public sealed record InferenceStatusDto(
    bool Available,
    string ModelId,
    string Label,
    IReadOnlyList<InferenceModelDto>? Models = null
);

/// <summary>One entry of the relay's model allowlist, as offered to the picker.</summary>
/// <param name="Id">The id a client puts in <c>InferRequestDto.ModelId</c>.</param>
/// <param name="Label">Display name; falls back to the id when none is configured.</param>
public sealed record InferenceModelDto(string Id, string Label);
