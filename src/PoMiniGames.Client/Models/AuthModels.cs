namespace PoMiniGamesClient.Models;

public class AuthClientConfiguration
{
    public bool Enabled { get; set; }
    public string ClientId { get; set; } = "";
    public string Authority { get; set; } = "";
    public string Scope { get; set; } = "";
    public string RedirectPath { get; set; } = "";
    public bool MicrosoftEnabled { get; set; }
    public bool MicrosoftConfigured { get; set; }
    public bool DevLoginEnabled { get; set; }
    public bool UsingMockData { get; set; }
    public bool AutoGuestLogin { get; set; }
}

public class AuthenticatedUserProfile
{
    public string UserId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string? Email { get; set; }
}

public class DevLoginRequest
{
    public string? UserId { get; set; }
    public string? DisplayName { get; set; }
    public string? Email { get; set; }
}

/// <summary>
/// Wire shape for <c>/api/auth/handshake</c>: pairs <see cref="AuthClientConfiguration"/>
/// with the optional <see cref="AuthenticatedUserProfile"/> for the current session.
/// </summary>
public sealed record AuthHandshake(
    AuthClientConfiguration? Config,
    AuthenticatedUserProfile? User);
