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

    public bool Enabled => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ApiClientId);

    public string EffectiveScope => !string.IsNullOrWhiteSpace(Scope)
        ? Scope
        : string.IsNullOrWhiteSpace(ApiClientId)
            ? string.Empty
            : $"api://{ApiClientId}/access_as_user";
}
