namespace PoMiniGames.Infrastructure;

/// <summary>Configures CORS to allow the React dev server and the hosted app origins.</summary>
internal static class CorsExtensions
{
    public static IServiceCollection AddPoMiniGamesCors(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddCors(options =>
        {
            options.AddDefaultPolicy(policy =>
            {
                var origins = configuration
                    .GetSection("PoMiniGames:Cors:AllowedOrigins").Get<string[]>()
                    ?? configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
                    ?? ["http://localhost:5000", "http://localhost:5173"];
                policy.WithOrigins(origins).AllowAnyMethod().AllowAnyHeader().AllowCredentials();
            });
        });

        return services;
    }
}
