using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.Auth;

/// <summary>
/// Developer bypass authentication handler.
/// Automatically authenticates all requests as a local dev user — no login step required.
/// Only registered when ASPNETCORE_ENVIRONMENT = Development.
/// </summary>
public sealed class DevBypassAuthHandler : AuthenticationHandler<AuthenticationSchemeOptions>
{
    public DevBypassAuthHandler(
        IOptionsMonitor<AuthenticationSchemeOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder)
        : base(options, logger, encoder)
    {
    }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        // Try to get user from ?user= query parameter
        var displayName = "Dev Admin";
        var email = "devadmin@local.dev";
        var userId = "dev-bypass-user";

        if (Request.Query.TryGetValue("user", out var userParam) && !string.IsNullOrEmpty(userParam.ToString()))
        {
            var userValue = userParam.ToString()!.Trim();
            displayName = userValue;
            // Normalize for userId/email (lowercase, remove spaces)
            var normalized = userValue.ToLowerInvariant().Replace(" ", "");
            userId = $"dev-{normalized}";
            email = $"dev-{normalized}@local.dev";
        }

        // Create a fake identity with the claims the app expects
        var claims = new[]
        {
            new Claim("oid",                       userId),
            new Claim(ClaimTypes.NameIdentifier,   userId),
            new Claim(ClaimTypes.Name,             displayName),
            new Claim("name",                      displayName),
            new Claim("preferred_username",        email),
            new Claim(ClaimTypes.Email,            email),
        };

        var identity  = new ClaimsIdentity(claims, AuthSchemes.DevBypass);
        var principal = new ClaimsPrincipal(identity);
        var ticket    = new AuthenticationTicket(principal, AuthSchemes.DevBypass);

        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}
