using Serilog.Context;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Pushes per-request properties into Serilog LogContext so all logs in the request pipeline
/// include user/session/environment/correlation metadata.
/// </summary>
internal sealed class RequestLogContextMiddleware
{
    public const string SessionItemKey = "PoMiniGames.SessionId";

    private readonly RequestDelegate _next;
    private readonly IHostEnvironment _hostEnvironment;

    public RequestLogContextMiddleware(RequestDelegate next, IHostEnvironment hostEnvironment)
    {
        _next = next;
        _hostEnvironment = hostEnvironment;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var userId = context.User?.Identity?.IsAuthenticated == true
            ? context.User.Identity?.Name ?? "anonymous"
            : "anonymous";

        var correlationId = context.TraceIdentifier;
        var sessionId = ResolveOrCreateSessionId(context);
        context.Items[SessionItemKey] = sessionId;

        using (LogContext.PushProperty("UserId", userId))
        using (LogContext.PushProperty("CorrelationId", correlationId))
        using (LogContext.PushProperty("SessionId", sessionId))
        using (LogContext.PushProperty("Environment", _hostEnvironment.EnvironmentName))
        {
            await _next(context);
        }
    }

    private static string ResolveOrCreateSessionId(HttpContext context)
    {
        const string cookieName = "po-session-id";

        if (context.Request.Cookies.TryGetValue(cookieName, out var existing) &&
            !string.IsNullOrWhiteSpace(existing))
        {
            return existing;
        }

        var generated = Guid.NewGuid().ToString("n");
        context.Response.Cookies.Append(cookieName, generated, new CookieOptions
        {
            HttpOnly = true,
            IsEssential = true,
            SameSite = SameSiteMode.Lax,
            Secure = context.Request.IsHttps,
            MaxAge = TimeSpan.FromDays(30),
        });

        return generated;
    }
}
