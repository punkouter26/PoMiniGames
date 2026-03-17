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
        // Create a fake identity with the claims the app expects
        var claims = new[]
        {
            new Claim("oid",                       "dev-bypass-user"),
            new Claim(ClaimTypes.NameIdentifier,   "dev-bypass-user"),
            new Claim(ClaimTypes.Name,             "Dev Admin"),
            new Claim("name",                      "Dev Admin"),
            new Claim("preferred_username",        "devadmin@local.dev"),
            new Claim(ClaimTypes.Email,            "devadmin@local.dev"),
        };

        var identity  = new ClaimsIdentity(claims, AuthSchemes.DevBypass);
        var principal = new ClaimsPrincipal(identity);
        var ticket    = new AuthenticationTicket(principal, AuthSchemes.DevBypass);

        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}
