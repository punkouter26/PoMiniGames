// filepath: src/PoShared/Interfaces/IMockable.cs
namespace PoShared.Interfaces;

/// <summary>
/// Marker interface for in-process mock / stub implementations of cross-game
/// services. A mock implementation of any service (AI boundary, storage, payment)
/// implements <see cref="IMockable"/> in addition to the production contract so a
/// runtime enumeration (<c>GET /api/mockables</c>) can answer "which services in
/// this container are mocks?" without reflection over private DI registration
/// state.
/// </summary>
/// <remarks>
/// <para><b>§5 Mockable Marker.</b> Pre-marker, the only signal that a service was
/// a mock was a per-service boolean (e.g. <c>IFaceAnalysisService.IsMock</c>),
/// which forced every consumer to know the exact field name. Lifting the contract
/// to <see cref="IMockable"/> lets the API and the dev tooling query a single
/// uniform projection.</para>
/// <para><b>Pattern: Marker + Stable Identifier.</b> The string <see cref="MockId"/>
/// is what surfaces on <c>/api/mockables</c>. It should be the fully-qualified
/// service-contract name plus a stable implementation suffix (e.g.
/// <c>IFaceAnalysisService:Stub</c>) so the output is greppable across deploys.</para>
/// </remarks>
public interface IMockable
{
    /// <summary>
    /// Stable identifier surfaced on the diagnostic <c>/api/mockables</c> endpoint.
    /// Conventions: <c>{ServiceContractName}:{ImplementationKind}</c>
    /// (e.g. <c>IFaceAnalysisService:Stub</c>, <c>IFaceAnalysisService:Azure</c>).
    /// The value MUST be stable across deploys so external automation (CI badges,
    /// audit dashboards) can match on it without false negatives.
    /// </summary>
    string MockId { get; }
}
