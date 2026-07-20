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
    /// 2026-07-19 browser audit #3+#4: the previous implementation wrapped the call
    /// in a bare try/catch and returned null on every failure, including the
    /// ERR_ABORTED that fires when a navigation tears down the in-flight
    /// request AND the X-Reauth header that signals a stale-cookie unprotect
    /// failure. We now surface both as distinct exceptions so the caller can
    /// keep the previous user on a transient abort and force a fresh dev
    /// login on a reauth signal.
    /// </summary>
    public async Task<AuthHandshake?> GetAuthHandshakeAsync()
    {
        AuthHandshakeReauthRequiredException? reauth = null;
        try
        {
            using var response = await _http.GetAsync("/api/auth/handshake");
            if (response.Headers.TryGetValues("X-Reauth", out var reauthHeader)
                && reauthHeader.Any(v => v == "1"))
            {
                // The server's data-protection key ring was rebuilt; the
                // cookie we sent is no longer decryptable. The caller must
                // trigger a fresh dev-login so the user isn't stranded on
                // a stale identity.
                reauth = new AuthHandshakeReauthRequiredException("Auth cookie no longer decryptable");
            }
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }
            return await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.AuthHandshake);
        }
        catch (HttpRequestException ex) when (ex.StatusCode is null)
        {
            // Transport-level failure (DNS, connection refused, aborted
            // navigation). Surface so the caller can keep the previous
            // identity and show a "Reconnecting…" hint.
            throw new AuthHandshakeUnavailableException("Auth handshake unreachable", ex);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Auth-side failure (5xx, schema drift, etc). Same surface as
            // before: clear state and let the caller re-hydrate.
            return null;
        }
        finally
        {
            if (reauth is not null) throw reauth;
        }
    }

    /// <summary>
    /// Thrown when the auth handshake can't be reached at the transport layer
    /// (no HTTP response — e.g. aborted by navigation, DNS, connection refused).
    /// AuthStateService treats this as transient: keep the previous user rather
    /// than blanking the header on a navigation race.
    /// </summary>
    public sealed class AuthHandshakeUnavailableException : Exception
    {
        public AuthHandshakeUnavailableException(string message, Exception inner) : base(message, inner) { }
    }

    /// <summary>
    /// Thrown when the server responded 401 with <c>X-Reauth: 1</c>, meaning the
    /// data-protection key ring was rebuilt and the existing DevCookie can no
    /// longer be unprotected. AuthStateService treats this as a forced
    /// re-login: issue a fresh guest identity before continuing.
    /// </summary>
    public sealed class AuthHandshakeReauthRequiredException : Exception
    {
        public AuthHandshakeReauthRequiredException(string message) : base(message) { }
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

    /// <summary>
    /// One game's normalized leaderboard. Backs the top-3 board that the shared
    /// GameShell renders inside every end-of-game modal, so the unit and ordering
    /// come from the server rather than each game re-deriving them.
    /// Returns null when the game has no board (404) or the API is offline — the
    /// modal simply omits the section.
    /// </summary>
    public async Task<GameLeaderboardDto?> GetGameLeaderboardAsync(string game, int limit = 3)
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

    /// <summary>
    /// Submits a PoMarbleRace score. The outcome distinguishes "retry later" from "never retry":
    /// collapsing both into null meant a server that rejected every submission was indistinguishable
    /// from being offline, so scores were parked in the sync queue forever and the player was told
    /// they were offline while online.
    /// </summary>
    public async Task<ScoreSubmitResult<MarbleRaceHighScore>> SubmitMarbleRaceHighScoreAsync(MarbleRaceHighScoreRequest entry)
    {
        try
        {
            var response = await _http.PostAsJsonAsync(
                "/api/marblerace/highscores", entry, ApiJsonContext.Default.MarbleRaceHighScoreRequest);

            if (response.IsSuccessStatusCode)
            {
                var saved = await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.MarbleRaceHighScore);
                return ScoreSubmitResult<MarbleRaceHighScore>.Saved(saved);
            }

            // 4xx: the payload itself is the problem, so replaying it just wedges the queue.
            if ((int)response.StatusCode is >= 400 and < 500)
                return ScoreSubmitResult<MarbleRaceHighScore>.Rejected(response.StatusCode);

            return ScoreSubmitResult<MarbleRaceHighScore>.Unavailable(response.StatusCode);
        }
        catch
        {
            // No response at all — genuinely offline/unreachable.
            return ScoreSubmitResult<MarbleRaceHighScore>.Unavailable(null);
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

    // ─── PoFunQuiz leaderboard ───────────────────────────────────────────

    /// <summary>
    /// GET /api/funquiz/leaderboard?category=…&top=… — top scores for a single category.
    /// Returns an empty list when the user is signed out (the endpoint requires auth).
    /// </summary>
    public async Task<FunQuizLeaderboardRow[]?> GetFunQuizLeaderboardAsync(string category, int top = 20)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                $"/api/funquiz/leaderboard?category={Uri.EscapeDataString(category)}&top={top}",
                ApiJsonContext.Default.FunQuizLeaderboardRowArray);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// POST /api/funquiz/leaderboard — submits a solo run. Server clamps Score to
    /// 0..10_000 and overrides PlayerName with the authenticated identity, so a
    /// spoof attempt from the client can't poison the board.
    /// </summary>
    public async Task<bool> SubmitFunQuizScoreAsync(FunQuizLeaderboardSubmission entry)
    {
        try
        {
            var response = await _http.PostAsJsonAsync(
                "/api/funquiz/leaderboard", entry, ApiJsonContext.Default.FunQuizLeaderboardSubmission);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }
}
