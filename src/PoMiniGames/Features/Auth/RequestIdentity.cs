using System.Security.Claims;

namespace PoMiniGames.Features.Auth;

/// <summary>
/// Resolves the server-authoritative caller identity from the auth cookie/JWT claims,
/// so leaderboard and match-history writes never trust a client-supplied name or owner.
/// Mirrors the inline pattern PoRacerScoreEndpoints already uses (oid → nameidentifier →
/// sub for the id; name → preferred_username → Identity.Name for the display name), but
/// hoisted into one place so every slice classifies identity the same way.
/// </summary>
public static class RequestIdentity
{
    /// <param name="UserId">Stable id from the claims, or empty for a truly-anonymous caller.</param>
    /// <param name="DisplayName">Human-facing name from the claims, or empty when none is present.</param>
    /// <param name="IsGuest">True when there is no stable id or the caller is in the "guest" role.</param>
    /// <param name="IsAuthenticated">True when a real (non-guest) identity is present — the case
    /// where the server overrides any client-supplied name/owner with the claim value.</param>
    public readonly record struct Identity(string UserId, string DisplayName, bool IsGuest, bool IsAuthenticated);

    public static Identity Resolve(ClaimsPrincipal? user)
    {
        var userId = user?.FindFirstValue("oid")
                     ?? user?.FindFirstValue(ClaimTypes.NameIdentifier)
                     ?? user?.FindFirstValue("sub")
                     ?? "";
        var displayName = user?.FindFirstValue("name")
                          ?? user?.FindFirstValue("preferred_username")
                          ?? user?.Identity?.Name
                          ?? "";
        var isGuest = string.IsNullOrEmpty(userId) || (user?.IsInRole("guest") ?? true);
        // "Authenticated" here means a real signed-in identity: a stable id that is not a guest.
        var isAuthenticated = !string.IsNullOrEmpty(userId) && !isGuest;
        return new Identity(userId, displayName, isGuest, isAuthenticated);
    }
}
