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
            DevLoginRequest? request = null;
            if (httpRequest.HasJsonContentType())
            {
                request = await httpRequest.ReadFromJsonAsync<DevLoginRequest>();
            }

            return await SignInDevelopmentUserAsync(context, environment, request, null);
        })
        .WithName("DevLogin")
        .WithTags("Auth")
        .WithSummary("Creates a local development auth session without Microsoft OAuth.");

        app.MapPost("/api/auth/dev-bypass", [AllowAnonymous] (HttpContext context, string? user, IWebHostEnvironment environment) =>
                SignInDevelopmentUserAsync(context, environment, null, user))
            .WithName("DevBypass")
            .WithTags("Auth")
            .WithSummary("Creates a dev session keyed to the selected display name.");

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

    private static async Task<IResult> SignInDevelopmentUserAsync(
        HttpContext context,
        IWebHostEnvironment environment,
        DevLoginRequest? request,
        string? userName)
    {
        if (!environment.IsDevelopment())
        {
            return Results.NotFound();
        }

        var profile = BuildDevelopmentProfile(request, userName);
        var claims = new[]
        {
            new Claim("oid", profile.UserId),
            new Claim(ClaimTypes.NameIdentifier, profile.UserId),
            new Claim(ClaimTypes.Name, profile.DisplayName),
            new Claim("name", profile.DisplayName),
            new Claim("preferred_username", profile.Email ?? string.Empty),
            new Claim(ClaimTypes.Email, profile.Email ?? string.Empty),
        };

        var identity = new ClaimsIdentity(claims, AuthSchemes.DevCookie);
        var principal = new ClaimsPrincipal(identity);

        await context.SignInAsync(AuthSchemes.DevCookie, principal, new AuthenticationProperties
        {
            IsPersistent = true,
            ExpiresUtc = DateTimeOffset.UtcNow.AddHours(12),
            AllowRefresh = true,
        });

        return Results.Ok(profile);
    }

    private static AuthenticatedUserProfile BuildDevelopmentProfile(DevLoginRequest? request, string? userName)
    {
        var fallbackName = string.IsNullOrWhiteSpace(userName) ? "Local Developer" : "Dev Admin";
        var displayName = SanitizeDisplayName(request?.DisplayName ?? userName, fallbackName);
        var slug = displayName.ToLowerInvariant().Replace(" ", "-", StringComparison.Ordinal);
        var userId = string.IsNullOrWhiteSpace(request?.UserId) ? $"dev-{slug}" : request!.UserId!.Trim();
        var email = string.IsNullOrWhiteSpace(request?.Email) ? $"{slug}@local.dev" : request!.Email!.Trim();
        return new AuthenticatedUserProfile(userId, displayName, email);
    }

    private static string SanitizeDisplayName(string? rawName, string fallback)
    {
        var source = string.IsNullOrWhiteSpace(rawName) ? fallback : rawName.Trim();
        var cleaned = new string(source.Where(c => char.IsLetterOrDigit(c) || c == ' ' || c == '-').ToArray());
        return string.IsNullOrWhiteSpace(cleaned) ? fallback : cleaned;
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
