using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Registers the authentication scheme (DevCookie / JWT Bearer) for the current environment.
/// </summary>
internal static class AuthExtensions
{
    public static IServiceCollection AddPoMiniGamesAuth(
        this IServiceCollection services,
        IWebHostEnvironment env,
        IConfiguration configuration)
    {
        var microsoftAuthSection = configuration.GetSection(MicrosoftAuthOptions.SectionName);
        services.Configure<MicrosoftAuthOptions>(microsoftAuthSection);
        var microsoftAuthOptions = microsoftAuthSection.Get<MicrosoftAuthOptions>() ?? new MicrosoftAuthOptions();

        var devLoginEnabled = env.IsDevelopment();

        // Fake auth is a Dev-only convenience, gated behind an explicit flag. It is NEVER
        // registered in Production (a startup guard in Program.cs enforces this).
        var fakeAuthEnabled = env.IsDevelopment()
            && configuration.GetValue<bool>("Auth:EnableFakeAuth");

        var authBuilder = services.AddAuthentication(options =>
            {
                options.DefaultAuthenticateScheme = AuthSchemes.Composite;
                options.DefaultChallengeScheme = AuthSchemes.Composite;
            })
            .AddPolicyScheme(AuthSchemes.Composite, AuthSchemes.Composite, options =>
            {
                options.ForwardDefaultSelector = context =>
                {
                    var authHeader = context.Request.Headers.Authorization.ToString();
                    if (!string.IsNullOrWhiteSpace(authHeader)
                        && authHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                    {
                        return JwtBearerDefaults.AuthenticationScheme;
                    }

                    if (context.Request.Query.ContainsKey("access_token")
                        && !string.IsNullOrWhiteSpace(context.Request.Query["access_token"]))
                    {
                        return JwtBearerDefaults.AuthenticationScheme;
                    }

                    if (fakeAuthEnabled && context.Request.Headers.ContainsKey(FakeAuthHandler.UserHeader))
                    {
                        return FakeAuthHandler.SchemeName;
                    }

                    if (devLoginEnabled)
                    {
                        return AuthSchemes.DevCookie;
                    }

                    return JwtBearerDefaults.AuthenticationScheme;
                };
            });

        if (fakeAuthEnabled)
        {
            authBuilder.AddScheme<AuthenticationSchemeOptions, FakeAuthHandler>(
                FakeAuthHandler.SchemeName, _ => { });
        }

        authBuilder
            .AddCookie(AuthSchemes.DevCookie, options =>
            {
                options.Cookie.Name = "PoMiniGames.DevAuth";
                options.Cookie.HttpOnly = true;
                options.Cookie.SameSite = SameSiteMode.Lax;
                options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
                options.Events = new CookieAuthenticationEvents
                {
                    OnRedirectToLogin = context =>
                    {
                        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                        return Task.CompletedTask;
                    },
                    OnRedirectToAccessDenied = context =>
                    {
                        context.Response.StatusCode = StatusCodes.Status403Forbidden;
                        return Task.CompletedTask;
                    },
                };
            })
            .AddJwtBearer(options =>
            {
                var authority = microsoftAuthOptions.Authority;
                var audience = microsoftAuthOptions.ApiClientId;

                options.MapInboundClaims = false;
                options.RequireHttpsMetadata = !env.IsDevelopment();

                if (!string.IsNullOrWhiteSpace(authority))
                {
                    options.Authority = authority;
                }

                options.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuer = false,
                    ValidateAudience = !string.IsNullOrWhiteSpace(audience),
                    ValidAudience = audience,
                    NameClaimType = "name",
                    RoleClaimType = "roles",
                };

                options.Events = new JwtBearerEvents
                {
                    OnMessageReceived = context =>
                    {
                        var accessToken = context.Request.Query["access_token"];
                        var path = context.HttpContext.Request.Path;
                        if (!string.IsNullOrWhiteSpace(accessToken) && path.StartsWithSegments("/api/hubs"))
                        {
                            context.Token = accessToken;
                        }

                        return Task.CompletedTask;
                    },
                };
            });

        return services;
    }
}
