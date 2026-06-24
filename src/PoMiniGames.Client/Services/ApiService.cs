using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services;

public class ApiService
{
    private readonly HttpClient _http;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);
    private static readonly JsonSerializerOptions JsonOptions = CreateJsonOptions();

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
        };
        // Fast path: source-generated metadata for the known API DTOs, with the reflection
        // resolver chained behind it so any unlisted type still serializes. Must be set
        // before the options are first used (after that the chain is frozen).
        options.TypeInfoResolverChain.Insert(0, ApiJsonContext.Default);
        options.TypeInfoResolverChain.Add(new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver());
        return options;
    }

    public ApiService(HttpClient http)
    {
        _http = http;
    }

    /// <summary>
    /// Attaches (or clears) the Microsoft access token as the default bearer for every
    /// subsequent API call, so authenticated endpoints work after MSAL sign-in.
    /// </summary>
    public void SetBearer(string? token)
    {
        _http.DefaultRequestHeaders.Authorization = string.IsNullOrEmpty(token)
            ? null
            : new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
    }

    public async Task<bool> IsAvailableAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(Timeout);
            var response = await _http.GetAsync("/api/health/ping", cts.Token);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<AuthClientConfiguration?> GetAuthConfigurationAsync()
    {
        try
        {
            return await _http.GetFromJsonAsync<AuthClientConfiguration>("/api/auth/config", JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    public async Task<AuthenticatedUserProfile?> DevLoginAsync(DevLoginRequest? request = null)
    {
        try
        {
            var response = await _http.PostAsJsonAsync("/api/auth/dev-login", request ?? new DevLoginRequest(), JsonOptions);
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync<AuthenticatedUserProfile>(JsonOptions) : null;
        }
        catch
        {
            return null;
        }
    }

    public async Task<AuthenticatedUserProfile?> DevBypassAsync(string? userName = null)
    {
        var name = string.IsNullOrWhiteSpace(userName) ? "Dev Admin" : userName;
        var slug = name.Trim().ToLowerInvariant().Replace(' ', '-');
        return await DevLoginAsync(new DevLoginRequest
        {
            UserId = $"dev-{slug}",
            DisplayName = name,
            Email = $"{slug}@local.dev"
        });
    }

    public async Task<bool> DevLogoutAsync()
    {
        try
        {
            var response = await _http.PostAsync("/api/auth/dev-logout", null);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<AuthenticatedUserProfile?> GetAuthenticatedUserAsync(string? accessToken = null)
    {
        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, "/api/auth/me");
            if (!string.IsNullOrEmpty(accessToken))
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);

            var response = await _http.SendAsync(request);
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync<AuthenticatedUserProfile>(JsonOptions) : null;
        }
        catch
        {
            return null;
        }
    }

    public async Task<PlayerStatsDto?> GetPlayerStatsAsync(string game, string playerName)
    {
        try
        {
            return await _http.GetFromJsonAsync<PlayerStatsDto>(
                $"/api/{game}/players/{Uri.EscapeDataString(playerName)}/stats", JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    public async Task<(bool Ok, int Status)> SavePlayerStatsAsync(string game, string playerName, PlayerStats stats)
    {
        try
        {
            var response = await _http.PutAsJsonAsync(
                $"/api/{game}/players/{Uri.EscapeDataString(playerName)}/stats", stats, JsonOptions);
            return (response.IsSuccessStatusCode, (int)response.StatusCode);
        }
        catch
        {
            return (false, 0);
        }
    }

    public async Task<PlayerStatsDto[]?> GetLeaderboardAsync(string game, int limit = 10, string? difficulty = null)
    {
        try
        {
            var query = $"?limit={limit}";
            if (!string.IsNullOrEmpty(difficulty) && difficulty != "all")
                query += $"&difficulty={difficulty}";

            return await _http.GetFromJsonAsync<PlayerStatsDto[]>(
                $"/api/{game}/statistics/leaderboard{query}", JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    public async Task<SnakeHighScore[]?> GetSnakeHighScoresAsync(int count = 10)
    {
        try
        {
            return await _http.GetFromJsonAsync<SnakeHighScore[]>(
                $"/api/snake/highscores?count={count}", JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    public async Task<SnakeHighScore?> SubmitSnakeHighScoreAsync(SnakeHighScore entry)
    {
        try
        {
            entry.Date = DateTime.UtcNow.ToString("O");
            var response = await _http.PostAsJsonAsync("/api/snake/highscores", entry, JsonOptions);
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync<SnakeHighScore>(JsonOptions) : null;
        }
        catch
        {
            return null;
        }
    }

    public async Task<MarbleRaceHighScore[]?> GetMarbleRaceHighScoresAsync(int count = 10)
    {
        try
        {
            return await _http.GetFromJsonAsync<MarbleRaceHighScore[]>(
                $"/api/marblerace/highscores?count={count}", JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    public async Task<MarbleRaceHighScore?> SubmitMarbleRaceHighScoreAsync(MarbleRaceHighScore entry)
    {
        try
        {
            entry.Date = DateTime.UtcNow.ToString("O");
            var response = await _http.PostAsJsonAsync("/api/marblerace/highscores", entry, JsonOptions);
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync<MarbleRaceHighScore>(JsonOptions) : null;
        }
        catch
        {
            return null;
        }
    }

    // ─── Head-to-head match history ──────────────────────────────────────

    public async Task<bool> RecordMatchAsync(MatchRecordRequest request)
    {
        try
        {
            var response = await _http.PostAsJsonAsync("/api/matches", request, JsonOptions);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<MatchRecordDto[]?> GetMatchesAsync(string owner, int limit = 500)
    {
        try
        {
            return await _http.GetFromJsonAsync<MatchRecordDto[]>(
                $"/api/matches?owner={Uri.EscapeDataString(owner)}&limit={limit}", JsonOptions);
        }
        catch
        {
            return null;
        }
    }
}
