using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.Auth;

/// <summary>
/// Header-driven fake authentication for Dev and Test environments only.
/// Authenticates a request when an <see cref="UserHeader"/> is supplied, optionally
/// assigning roles from <see cref="RolesHeader"/>. Absence of the header yields
/// <see cref="AuthenticateResult.NoResult"/> (anonymous), never an error.
/// </summary>
/// <remarks>
/// Pattern: Strategy. This handler is an interchangeable <see cref="IAuthenticationHandler"/>
/// strategy swapped in for real Microsoft OAuth in non-production environments, allowing tests
/// to assert identity variations by injecting headers without performing a real OAuth handshake.
/// A production startup guard (see Program.cs) throws if this scheme is ever registered in Production.
/// </remarks>
public sealed class FakeAuthHandler : AuthenticationHandler<AuthenticationSchemeOptions>
{
    public const string SchemeName = "FakeAuth";
    public const string UserHeader = "X-Fake-User";
    public const string RolesHeader = "X-Fake-Roles";

    public FakeAuthHandler(
        IOptionsMonitor<AuthenticationSchemeOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder)
        : base(options, logger, encoder)
    {
    }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Headers.TryGetValue(UserHeader, out var user) || string.IsNullOrEmpty(user))
        {
            return Task.FromResult(AuthenticateResult.NoResult()); // Not an error - just unauthenticated
        }

        var email = user!.ToString().Contains('@') ? user!.ToString() : $"{user}@example.com";
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user!),
            new("oid", user!),
            new(ClaimTypes.Name, user!),
            new("name", user!),
            new(ClaimTypes.Email, email),
            new("preferred_username", email),
        };

        if (Request.Headers.TryGetValue(RolesHeader, out var roles) && !string.IsNullOrEmpty(roles))
        {
            foreach (var role in roles.ToString().Split(',', StringSplitOptions.RemoveEmptyEntries))
            {
                claims.Add(new Claim(ClaimTypes.Role, role.Trim()));
                claims.Add(new Claim("roles", role.Trim()));
            }
        }

        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName)));
    }
}
