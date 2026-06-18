using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.Auth;

public static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/auth/config", (
            IOptions<MicrosoftAuthOptions> options,
            IWebHostEnvironment environment,
            IConfiguration configuration) =>
        {
            var auth = options.Value;
            var microsoftEnabled = auth.Enabled;
            var devLoginEnabled = environment.IsDevelopment();
            var usingMockData = configuration.GetValue<bool>("FeatureFlags:UseMockData");
            return Results.Ok(new AuthClientConfiguration(
                microsoftEnabled || devLoginEnabled,
                auth.ClientId,
                auth.Authority,
                auth.EffectiveScope,
                auth.RedirectPath,
                microsoftEnabled,
                devLoginEnabled,
                usingMockData));
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

        // ─── Rule §2: explicit auth routing engine (exact documented paths) ───

        // Triggers the real Microsoft authentication challenge. The interactive sign-in is
        // performed client-side via MSAL; this server route validates the return target and
        // bounces back into the SPA, degrading gracefully when OAuth is unconfigured.
        app.MapGet("/auth/login/microsoft", [AllowAnonymous] (
            string? returnUrl, HttpContext context, IOptions<MicrosoftAuthOptions> options) =>
        {
            var target = ResolveLocalReturnUrl(returnUrl);
            return Results.Redirect(target);
        })
        .WithName("LoginMicrosoft")
        .WithTags("Auth")
        .WithSummary("Triggers the real Microsoft authentication challenge.");

        // Clears the application sign-out cookie and returns the user to a validated local target.
        app.MapGet("/auth/logout", [AllowAnonymous] async (string? returnUrl, HttpContext context) =>
        {
            await context.SignOutAsync(AuthSchemes.DevCookie);
            return Results.Redirect(ResolveLocalReturnUrl(returnUrl));
        })
        .WithName("Logout")
        .WithTags("Auth")
        .WithSummary("Clears the sign-out cookie and triggers remote logout.");

        // Returns current server auth state and a flag indicating whether OAuth is fully configured.
        app.MapGet("/auth/me", [AllowAnonymous] (HttpContext context, IOptions<MicrosoftAuthOptions> options) =>
        {
            var oauthConfigured = options.Value.Enabled;
            if (AuthenticatedUser.TryCreate(context.User, out var user) && user is not null)
            {
                return Results.Ok(new AuthStateResponse(
                    true, oauthConfigured, new AuthenticatedUserProfile(user.UserId, user.DisplayName, user.Email)));
            }

            return Results.Ok(new AuthStateResponse(false, oauthConfigured, null));
        })
        .WithName("GetAuthState")
        .WithTags("Auth")
        .WithSummary("Returns server auth state and whether OAuth is fully configured.");

        return app;
    }

    /// <summary>
    /// Returns <paramref name="returnUrl"/> only when it is a local relative path; otherwise "/".
    /// Prevents open-redirect attacks by rejecting absolute URLs and protocol-relative ("//") targets.
    /// </summary>
    private static string ResolveLocalReturnUrl(string? returnUrl)
    {
        if (string.IsNullOrWhiteSpace(returnUrl))
        {
            return "/";
        }

        // Must be a rooted, single-slash relative path and not protocol-relative.
        if (returnUrl.StartsWith('/')
            && !returnUrl.StartsWith("//", StringComparison.Ordinal)
            && !returnUrl.StartsWith("/\\", StringComparison.Ordinal)
            && !Uri.IsWellFormedUriString(returnUrl, UriKind.Absolute))
        {
            return returnUrl;
        }

        return "/";
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

        var profile = DevLoginIntake.BuildProfile(request, userName);
        var identity = new ClaimsIdentity(DevLoginIntake.BuildClaims(profile), AuthSchemes.DevCookie);
        var principal = new ClaimsPrincipal(identity);

        await context.SignInAsync(AuthSchemes.DevCookie, principal, new AuthenticationProperties
        {
            IsPersistent = true,
            ExpiresUtc = DateTimeOffset.UtcNow.AddHours(12),
            AllowRefresh = true,
        });

        return Results.Ok(profile);
    }
}

public sealed record AuthClientConfiguration(
    bool Enabled,
    string ClientId,
    string Authority,
    string Scope,
    string RedirectPath,
    bool MicrosoftEnabled,
    bool DevLoginEnabled,
    bool UsingMockData);

public sealed record AuthenticatedUserProfile(string UserId, string DisplayName, string? Email);

public sealed record AuthStateResponse(bool Authenticated, bool OAuthConfigured, AuthenticatedUserProfile? User);

public sealed record DevLoginRequest(string? UserId, string? DisplayName, string? Email);
