namespace PoMiniGames.Features.Auth;

public sealed class MicrosoftAuthOptions
{
    public const string SectionName = "PoMiniGames:MicrosoftAuth";

    public string Authority { get; init; } = "https://login.microsoftonline.com/common/v2.0";

    public string ClientId { get; init; } = string.Empty;

    public string ApiClientId { get; init; } = string.Empty;

    public string Scope { get; init; } = string.Empty;

    public string RedirectPath { get; init; } = "/auth/callback";

    /// <summary>
    /// Additional tenant IDs allowed to issue tokens for this API. Combine with the well-known
    /// public authorities (common / organizations / consumers) which are always allowed.
    /// Example: <c>[ "11111111-1111-1111-1111-111111111111" ]</c>.
    /// </summary>
    public string[] AllowedTenantIds { get; init; } = Array.Empty<string>();

    /// <summary>
    /// Explicit dev override. Setting <c>PoMiniGames:MicrosoftAuth:Enabled=true</c> in
    /// <c>appsettings.Development.json</c> (or user-secrets) is enough to surface the
    /// Microsoft sign-in button in dev — even before the App Registration client IDs
    /// are wired. Real sign-in still requires <see cref="ClientId"/> + <see cref="ApiClientId"/>
    /// to be non-empty, but this lets a dev confirm the wiring is live before the
    /// Entra app is fully provisioned.
    /// </summary>
    public bool Enabled { get; init; }

    /// <summary>
    /// Returns <c>true</c> when sign-in can actually complete (the App Registration
    /// client IDs are present). Use this in the SPA to decide whether the Microsoft
    /// button is enabled vs. visible-but-disabled.
    /// </summary>
    public bool FullyConfigured => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ApiClientId);

    public string EffectiveScope => !string.IsNullOrWhiteSpace(Scope)
        ? Scope
        : string.IsNullOrWhiteSpace(ApiClientId)
            ? string.Empty
            : $"api://{ApiClientId}/access_as_user";
}
