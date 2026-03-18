using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.Auth;

public static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/auth/config", (IOptions<MicrosoftAuthOptions> options, IWebHostEnvironment environment) =>
        {
            var auth = options.Value;
            var microsoftEnabled = auth.Enabled;
            var devLoginEnabled = environment.IsDevelopment();
            return Results.Ok(new AuthClientConfiguration(
                microsoftEnabled || devLoginEnabled,
                auth.ClientId,
                auth.Authority,
                auth.EffectiveScope,
                auth.RedirectPath,
                microsoftEnabled,
                devLoginEnabled));
        })
        .WithName("GetAuthConfiguration")
        .WithTags("Auth")
        .WithSummary("Returns the public Microsoft sign-in configuration for the SPA.");

        app.MapPost("/api/auth/dev-login", [AllowAnonymous] async (HttpContext context, HttpRequest httpRequest, IWebHostEnvironment environment) =>
        {
            if (!environment.IsDevelopment())
            {
                return Results.NotFound();
            }

            DevLoginRequest? request = null;
            if (httpRequest.HasJsonContentType())
            {
                request = await httpRequest.ReadFromJsonAsync<DevLoginRequest>();
            }

            var userId = string.IsNullOrWhiteSpace(request?.UserId)
                ? "dev-user"
                : request.UserId.Trim();

            var displayName = string.IsNullOrWhiteSpace(request?.DisplayName)
                ? "Local Developer"
                : request.DisplayName.Trim();

            var email = string.IsNullOrWhiteSpace(request?.Email)
                ? $"{displayName.Replace(" ", string.Empty, StringComparison.Ordinal)}@local.dev"
                : request.Email.Trim();

            var claims = new[]
            {
                new Claim("oid", userId),
                new Claim(ClaimTypes.NameIdentifier, userId),
                new Claim(ClaimTypes.Name, displayName),
                new Claim("name", displayName),
                new Claim("preferred_username", email),
                new Claim(ClaimTypes.Email, email),
            };

            var identity = new ClaimsIdentity(claims, AuthSchemes.DevCookie);
            var principal = new ClaimsPrincipal(identity);

            await context.SignInAsync(AuthSchemes.DevCookie, principal, new AuthenticationProperties
            {
                IsPersistent = true,
                ExpiresUtc = DateTimeOffset.UtcNow.AddHours(12),
                AllowRefresh = true,
            });

            return Results.Ok(new AuthenticatedUserProfile(userId, displayName, email));
        })
        .WithName("DevLogin")
        .WithTags("Auth")
        .WithSummary("Creates a local development auth session without Microsoft OAuth.");

        // ─── Developer Bypass (Identity via URL) ────────────────────────────────
        // Open /?user=Alice in one tab, /?user=Bob in incognito → each gets a unique
        // cookie session.  SignalR hubs work because the DevCookie is sent with every
        // WebSocket upgrade request.
        app.MapPost("/api/auth/dev-bypass", [AllowAnonymous] async (HttpContext context, string? user, IWebHostEnvironment environment) =>
        {
            if (!environment.IsDevelopment())
            {
                return Results.NotFound();
            }

            // Sanitise: only allow letters, digits, spaces and hyphens to prevent injection
            var rawName = string.IsNullOrWhiteSpace(user) ? "Dev Admin" : user.Trim();
            var displayName = new string(rawName.Where(c => char.IsLetterOrDigit(c) || c == ' ' || c == '-').ToArray());
            if (string.IsNullOrWhiteSpace(displayName)) displayName = "Dev Admin";

            var userId = $"dev-{displayName.ToLowerInvariant().Replace(" ", "-", StringComparison.Ordinal)}";
            var email  = $"{userId}@local.dev";

            var claims = new[]
            {
                new Claim("oid",                       userId),
                new Claim(ClaimTypes.NameIdentifier,   userId),
                new Claim(ClaimTypes.Name,             displayName),
                new Claim("name",                      displayName),
                new Claim("preferred_username",        email),
                new Claim(ClaimTypes.Email,            email),
            };

            var identity  = new ClaimsIdentity(claims, AuthSchemes.DevCookie);
            var principal = new ClaimsPrincipal(identity);

            await context.SignInAsync(AuthSchemes.DevCookie, principal, new AuthenticationProperties
            {
                IsPersistent = true,
                ExpiresUtc   = DateTimeOffset.UtcNow.AddHours(12),
                AllowRefresh = true,
            });

            return Results.Ok(new AuthenticatedUserProfile(userId, displayName, email));
        })
        .WithName("DevBypass")
        .WithTags("Auth")
        .WithSummary("Creates a dev session keyed to the ?user= URL param — no Microsoft OAuth needed.");

        app.MapPost("/api/auth/dev-logout", [AllowAnonymous] async (HttpContext context, IWebHostEnvironment environment) =>
        {
            if (!environment.IsDevelopment())
            {
                return Results.NotFound();
            }

            await context.SignOutAsync(AuthSchemes.DevCookie);
            return Results.Ok();
        })
        .WithName("DevLogout")
        .WithTags("Auth")
        .WithSummary("Clears the local development auth session.");

        app.MapGet("/api/auth/me", [Authorize] (HttpContext context) =>
        {
            if (!AuthenticatedUser.TryCreate(context.User, out var user) || user is null)
            {
                return Results.Unauthorized();
            }

            return Results.Ok(new AuthenticatedUserProfile(user.UserId, user.DisplayName, user.Email));
        })
        .WithName("GetCurrentUser")
        .WithTags("Auth")
        .WithSummary("Returns the authenticated user profile for the current bearer token.")
        .Produces<AuthenticatedUserProfile>(StatusCodes.Status200OK)
        .Produces(StatusCodes.Status401Unauthorized);

        return app;
    }
}

public sealed record AuthClientConfiguration(
    bool Enabled,
    string ClientId,
    string Authority,
    string Scope,
    string RedirectPath,
    bool MicrosoftEnabled,
    bool DevLoginEnabled);

public sealed record AuthenticatedUserProfile(string UserId, string DisplayName, string? Email);

public sealed record DevLoginRequest(string? UserId, string? DisplayName, string? Email);
