namespace PoMiniGames.Features.Auth;

public static class AuthSchemes
{
    public const string Composite  = "Composite";
    public const string DevCookie  = "DevCookie";
    /// <summary>Automatically authenticates every request in Development — no login step required.</summary>
    public const string DevBypass  = "DevBypass";
}

