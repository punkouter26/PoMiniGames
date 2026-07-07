using System.Net.Http.Json;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services;

public class ApiService
{
    private readonly HttpClient _http;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

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
            // /api/health/ping is the cheapest possible liveness probe — no JSON,
            // no health-check service, just "200 OK / pong". Kept as the platform's
            // off-line detection sentinel; for richer diagnostics use /api/health.
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
            return await _http.GetFromJsonAsync("/api/auth/config", ApiJsonContext.Default.AuthClientConfiguration);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// §6: Single round-trip that returns the auth client config + (when a session
    /// cookie exists) the canonical user profile. Replaces the legacy two-call
    /// (config + me) handshake so AuthGate can hydrate with one RTT.
    /// </summary>
    public async Task<AuthHandshake?> GetAuthHandshakeAsync()
    {
        try
        {
            return await _http.GetFromJsonAsync("/api/auth/handshake", ApiJsonContext.Default.AuthHandshake);
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
            var response = await _http.PostAsJsonAsync("/api/auth/dev-login", request ?? new DevLoginRequest(), ApiJsonContext.Default.DevLoginRequest);
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.AuthenticatedUserProfile) : null;
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
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.AuthenticatedUserProfile) : null;
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
            return await _http.GetFromJsonAsync(
                $"/api/{game}/players/{Uri.EscapeDataString(playerName)}/stats", ApiJsonContext.Default.PlayerStatsDto);
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
                $"/api/{game}/players/{Uri.EscapeDataString(playerName)}/stats", stats, ApiJsonContext.Default.PlayerStats);
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

            return await _http.GetFromJsonAsync(
                $"/api/{game}/statistics/leaderboard{query}", ApiJsonContext.Default.PlayerStatsDtoArray);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Normalized leaderboards for every game in one round-trip (home preview, /leaderboards hub).</summary>
    public async Task<GameLeaderboardDto[]?> GetAllLeaderboardsAsync(int limit = 5)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                $"/api/leaderboards?limit={limit}", ApiJsonContext.Default.GameLeaderboardDtoArray);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Normalized leaderboard for a single game.</summary>
    public async Task<GameLeaderboardDto?> GetGameLeaderboardAsync(string game, int limit = 10)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                $"/api/leaderboards/{game}?limit={limit}", ApiJsonContext.Default.GameLeaderboardDto);
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
            return await _http.GetFromJsonAsync(
                $"/api/marblerace/highscores?count={count}", ApiJsonContext.Default.MarbleRaceHighScoreArray);
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
            // Stamp once; preserve across resync so the deterministic RowKey stays stable (no duplicates).
            if (string.IsNullOrEmpty(entry.Date))
                entry.Date = DateTime.UtcNow.ToString("O");
            var response = await _http.PostAsJsonAsync("/api/marblerace/highscores", entry, ApiJsonContext.Default.MarbleRaceHighScore);
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.MarbleRaceHighScore) : null;
        }
        catch
        {
            return null;
        }
    }

    public async Task<PoBrawlHighScore[]?> GetPoBrawlHighScoresAsync(int count = 10)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                $"/api/pobrawl/highscores?count={count}", ApiJsonContext.Default.PoBrawlHighScoreArray);
        }
        catch
        {
            return null;
        }
    }

    public async Task<PoBrawlHighScore?> SubmitPoBrawlHighScoreAsync(PoBrawlHighScore entry)
    {
        try
        {
            // Stamp once; preserve across resync so the deterministic RowKey stays stable (no duplicates).
            if (string.IsNullOrEmpty(entry.Date))
                entry.Date = DateTime.UtcNow.ToString("O");
            var response = await _http.PostAsJsonAsync("/api/pobrawl/highscores", entry, ApiJsonContext.Default.PoBrawlHighScore);
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.PoBrawlHighScore) : null;
        }
        catch
        {
            return null;
        }
    }

    public async Task<PoBrawlLadderEntry[]?> GetPoBrawlLadderAsync(int count = 10)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                $"/api/pobrawl/ladder?count={count}", ApiJsonContext.Default.PoBrawlLadderEntryArray);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Submits ladder progress. The server keeps one row per player with
    /// max-progress semantics, so a dropped submit self-heals on the next win —
    /// no offline resync queue needed.
    /// </summary>
    public async Task<PoBrawlLadderEntry?> SubmitPoBrawlLadderAsync(PoBrawlLadderEntry entry)
    {
        try
        {
            if (string.IsNullOrEmpty(entry.Date))
                entry.Date = DateTime.UtcNow.ToString("O");
            var response = await _http.PostAsJsonAsync("/api/pobrawl/ladder", entry, ApiJsonContext.Default.PoBrawlLadderEntry);
            return response.IsSuccessStatusCode ? await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.PoBrawlLadderEntry) : null;
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
            var response = await _http.PostAsJsonAsync("/api/matches", request, ApiJsonContext.Default.MatchRecordRequest);
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
            return await _http.GetFromJsonAsync(
                $"/api/matches?owner={Uri.EscapeDataString(owner)}&limit={limit}", ApiJsonContext.Default.MatchRecordDtoArray);
        }
        catch
        {
            return null;
        }
    }
}
