using Microsoft.Extensions.Logging;
using Microsoft.JSInterop;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services;

public class AuthStateService
{
    private readonly ApiService _api;
    private readonly IJSRuntime _js;
    private readonly ILogger<AuthStateService> _logger;
    private readonly PlayerNameService _playerName;
    private AuthClientConfiguration? _config;
    private AuthenticatedUserProfile? _user;
    private bool _initialized;
    private bool _msalInitialized;

    public AuthClientConfiguration? Config => _config;
    public AuthenticatedUserProfile? User => _user;
    public bool IsConfigured => _config?.Enabled == true;
    public bool UsingMockData => _config?.UsingMockData == true;
    public bool IsAuthenticated => _user != null;
    public bool IsLoading => !_initialized;
    public bool MicrosoftEnabled => _config?.MicrosoftEnabled == true;
    public bool MicrosoftConfigured => _config?.MicrosoftConfigured == true;
    public bool DevLoginEnabled => _config?.DevLoginEnabled == true;
    public string? AccessToken { get; private set; }
    public string? Error { get; private set; }

    public event Action? StateChanged;

    public AuthStateService(ApiService api, IJSRuntime js, ILogger<AuthStateService> logger, PlayerNameService playerName)
    {
        _api = api;
        _js = js;
        _logger = logger;
        _playerName = playerName;
    }

    /// <summary>Wire format for the MSAL JS interop result (see wwwroot/js/poauth.js).</summary>
    private sealed record MsalResult(string Name, string Username, string? AccessToken);

    public async Task InitializeAsync(string? queryString = null)
    {
        _initialized = false;
        Error = null;
        NotifyStateChanged();

        // §6: single-RTT auth handshake. The previous implementation fetched config
        // then user profile in two round-trips, causing one extra paint of the spinner.
        var handshake = await _api.GetAuthHandshakeAsync();
        if (handshake is null)
        {
            _user = null;
            _config = null;
            _initialized = true;
            NotifyStateChanged();
            return;
        }
        _config = handshake.Config;
        _user = handshake.User;

        if (_config == null || !_config.Enabled)
        {
            AccessToken = null;
            _initialized = true;
            NotifyStateChanged();
            return;
        }

        // Microsoft OAuth: drain the redirect callback (auth code in the URL) or
        // restore a cached MSAL session FIRST — even in dev, where DevLoginEnabled
        // is also true. This is what consumes the code left by the redirect flow
        // and clears MSAL's `interaction_in_progress` lock. The old ordering ran
        // the DevLoginEnabled branch first and returned before ever draining the
        // redirect, so the lock stayed stuck and every subsequent Microsoft
        // sign-in failed with "previously interrupted" (poauth.js signIn).
        if (_config.MicrosoftEnabled && await TryApplyMicrosoftSessionAsync())
        {
            _initialized = true;
            NotifyStateChanged();
            return;
        }

        if (_config.DevLoginEnabled)
        {
            AccessToken = null;

            // Check for ?user= query param (explicit dev-bypass entry).
            var urlUser = GetDevUserFromQuery(queryString);
            if (!string.IsNullOrEmpty(urlUser))
            {
                var profile = await _api.DevBypassAsync(urlUser);
                if (profile is not null)
                {
                    _user = profile;
                    // Keep the local PlayerNameService in sync so /profile shows
                    // the new identity, not the previously-cached player name.
                    // Wait for PlayerNameService.InitializeAsync first so the
                    // auth-derived value wins the localStorage race.
                    await _playerName.Initialized;
                    if (!string.IsNullOrWhiteSpace(profile.DisplayName))
                    {
                        _playerName.SetPlayerNameFromAuth(profile.DisplayName);
                    }
                }
                _initialized = true;
                NotifyStateChanged();
                return;
            }

            // Handshake already populated _user from the server-side cookie.
            if (_user is not null)
            {
                // Restore the local player-name from the auth cookie so the
                // GameShell "Player" slot matches the right-rail identity
                // (e.g. "guest@local.dev" ↔ "Guest") instead of a stale
                // random fallback that survived from a previous session.
                await SyncPlayerNameFromAuthAsync();
                _initialized = true;
                NotifyStateChanged();
                return;
            }

            // §9.3 chaos-engineering hardening: every auto-guest session gets a unique
            // per-tab suffix so the rate limiter can't collapse two different kiosk
            // browsers into the same bucket (which previously let one browser's burst
            // DOS another browser's legitimate guest actions).
            if (_config.AutoGuestLogin && IsAutoGuestOptIn(queryString))
            {
                var sessionTag = await JsSessionTagAsync();
                var profile = await _api.DevBypassAsync($"Guest-{sessionTag}");
                if (profile is null)
                {
                    // The server-side guest sign-in failed, so NO auth cookie exists.
                    // Do NOT fabricate a client-side identity here: minting a phantom
                    // AuthenticatedUserProfile would flip IsAuthenticated true while the
                    // server has no session, so every protected /api/* call would 401
                    // while the UI shows "signed in". Leave _user null and stay
                    // genuinely anonymous instead.
                    _initialized = true;
                    NotifyStateChanged();
                    return;
                }

                _user = new AuthenticatedUserProfile
                {
                    UserId = profile.UserId,
                    DisplayName = profile.DisplayName + " (auto)",
                    Email = profile.Email
                };
                _logger.AutoGuestSessionMinted();
                await SyncPlayerNameFromAuthAsync();
                _initialized = true;
                NotifyStateChanged();
                return;
            }

            _initialized = true;
            NotifyStateChanged();
            return;
        }

        _initialized = true;
        NotifyStateChanged();
    }

    /// <summary>
    /// Drain a pending MSAL redirect callback (auth code in the URL) or restore a
    /// cached MSAL account, applying the resulting Microsoft session. Returns true
    /// when an authenticated session was applied.
    ///
    /// Safe to call on every load where Microsoft is configured — even with no
    /// redirect in flight, invoking <c>handleRedirectPromise()</c> is what clears
    /// MSAL's <c>interaction_in_progress</c> lock after a redirect round-trip. This
    /// MUST run before the DevLoginEnabled short-circuit in <see cref="InitializeAsync"/>,
    /// otherwise (in dev, where both flags are set) the lock stays stuck and every
    /// subsequent Microsoft sign-in fails with "previously interrupted".
    ///
    /// Runs only when Microsoft is actually configured (ClientId + ApiClientId
    /// wired); an enabled-but-unwired config has no MSAL app to restore and would
    /// throw on init.
    /// </summary>
    private async Task<bool> TryApplyMicrosoftSessionAsync()
    {
        if (_config is null || !_config.MicrosoftConfigured) return false;

        // Do not block on a hung MSAL init when the handshake already restored a
        // server-side session (e.g. a dev cookie) — that path is handled by the
        // caller. We still attempt the drain so the redirect lock gets cleared.
        try
        {
            await EnsureMsalInitializedAsync();

            // First, drain any pending redirect-callback result. The redirect flow
            // (used when loginPopup is blocked) lands the browser on /auth/callback
            // with the auth code in the URL; MSAL processes it here and the SPA
            // navigates back to the original request URL.
            var redirectResult = await _js.InvokeAsync<MsalResult?>("poAuth.handleRedirect", _config.Scope);
            if (redirectResult is not null)
            {
                await ApplyMicrosoftSessionAsync(redirectResult);
                return _user is not null;
            }

            // No redirect in flight; fall back to a silent cache restore (the user
            // previously signed in on this machine).
            var restored = await _js.InvokeAsync<MsalResult?>("poAuth.tryRestore", _config.Scope);
            if (restored is not null)
            {
                await ApplyMicrosoftSessionAsync(restored);
                return _user is not null;
            }
        }
        catch (Exception ex)
        {
            _logger.SilentMsalRestoreFailed(ex.Message, ex);
        }

        return false;
    }

    /// <summary>
    /// Per-tab unique tag stored in sessionStorage. Auto-guest identities embed this tag
    /// so two tabs (or two kiosks behind the same NAT) get distinct rate-limit buckets.
    /// </summary>
    private async Task<string> JsSessionTagAsync()
    {
        try
        {
            var existing = await _js.InvokeAsync<string?>("sessionStorage.getItem", "poAutoGuestTag");
            if (!string.IsNullOrWhiteSpace(existing)) return existing!;
            var fresh = Guid.NewGuid().ToString("N")[..8];
            await _js.InvokeVoidAsync("sessionStorage.setItem", "poAutoGuestTag", fresh);
            return fresh;
        }
        catch
        {
            return Guid.NewGuid().ToString("N")[..8];
        }
    }

    private async Task EnsureMsalInitializedAsync()
    {
        if (_msalInitialized || _config is null) return;
        await _js.InvokeVoidAsync("poAuth.init", _config.ClientId, _config.Authority, _config.RedirectPath);
        _msalInitialized = true;
    }

    // Promote a successful MSAL result to an authenticated session: attach the bearer
    // token to the API client and resolve the canonical profile from the server.
    private async Task ApplyMicrosoftSessionAsync(MsalResult result)
    {
        AccessToken = result.AccessToken;
        _api.SetBearer(result.AccessToken);
        var profile = string.IsNullOrEmpty(result.AccessToken)
            ? null
            : await _api.GetAuthenticatedUserAsync(result.AccessToken);
        _user = profile ?? new AuthenticatedUserProfile
        {
            UserId = result.Username,
            DisplayName = string.IsNullOrWhiteSpace(result.Name) ? result.Username : result.Name,
            Email = result.Username
        };
        // Push the MSAL display name into PlayerNameService so the GameShell
        // "Player" slot and the right-rail identity stay in lockstep. Without
        // this, signing in with Microsoft would leave the top-bar showing a
        // stale random fallback (e.g. "BraveWolf32") while the auth rail
        // correctly shows the user's email.
        await SyncPlayerNameFromAuthAsync();
    }

    /// <summary>Interactive Microsoft sign-in (real MSAL when configured, dev-login stand-in otherwise).</summary>
    public async Task SignInMicrosoftAsync()
    {
        Error = null;
        if (_config is null)
        {
            Error = "Authentication is not configured.";
            NotifyStateChanged();
            return;
        }

        if (_config.MicrosoftEnabled)
        {
            // If the App Registration client IDs are not yet wired (e.g. dev just flipped
            // the Enabled flag but hasn't run `dotnet user-secrets set`), surface a clear,
            // actionable error instead of letting MSAL throw a confusing browser-side one.
            if (!_config.MicrosoftConfigured)
            {
                _logger.MicrosoftSignInNotConfigured();
                Error = "Microsoft sign-in is not fully configured. " +
                        "Set PoMiniGames:MicrosoftAuth:ClientId and ApiClientId via " +
                        "`dotnet user-secrets set` (see appsettings.Development.json for the path). " +
                        "Or continue as a Guest for now.";
                NotifyStateChanged();
                return;
            }

            try
            {
                await EnsureMsalInitializedAsync();
                var result = await _js.InvokeAsync<MsalResult?>("poAuth.signIn", _config.Scope);
                if (result is not null)
                {
                    await ApplyMicrosoftSessionAsync(result);
                }
                else
                {
                    _logger.SignInCancelled();
                    Error = "Sign-in was cancelled.";
                }
            }
            catch (Exception ex) when (ex.Message.Contains("popup_window_error", StringComparison.OrdinalIgnoreCase)
                                      || ex.Message.Contains("SecurityError", StringComparison.OrdinalIgnoreCase))
            {
                // Popup flow is blocked (e.g. embedded sandboxed iframes). Fall back to
                // a full-page redirect — this never throws back to .NET because the
                // browser navigates away, but it works everywhere a popup would.
                try
                {
                    await _js.InvokeVoidAsync("poAuth.signInRedirect", _config.Scope);
                }
                catch (Exception redirectEx)
                {
                    Error = $"Microsoft sign-in failed (redirect fallback also failed: {redirectEx.Message}). " +
                            "Try opening the app in a regular browser tab.";
                }
            }
            catch (Exception ex)
            {
                Error = $"Microsoft sign-in failed: {ex.Message}";
            }
        }
        else if (_config.DevLoginEnabled)
        {
            // No real Azure AD app configured locally — use the dev-login stand-in.
            var profile = await _api.DevLoginAsync();
            if (profile != null) _user = profile;
            else Error = "Sign in failed.";
        }
        else
        {
            Error = "Microsoft sign-in is not available.";
        }

        NotifyStateChanged();
    }

    /// <summary>Guest sign-in via the dev bypass (Development only).</summary>
    public async Task SignInGuestAsync()
    {
        Error = null;
        // Give every guest a unique "Guest######" name (6 random digits) so two
        // anonymous players can be told apart. Name is the identity key in the
        // multiplayer lobbies/scoring (Fun Quiz, Couple Quiz), so a shared "Guest"
        // name collapsed distinct players into one (both crowned King/host). The
        // server keys the guest identity off this name, and the session cookie
        // persists it across navigations, so the name stays stable for the session.
        var guestName = $"Guest{Random.Shared.Next(0, 1_000_000):D6}";
        var profile = await _api.DevBypassAsync(guestName);
        if (profile != null)
        {
            _user = profile;
            // Sync the in-game player-name with the new auth identity so the
            // GameShell "Player" slot shows "Guest" (the server-derived name)
            // instead of any stale random fallback left in localStorage from
            // a previous anonymous play.
            await SyncPlayerNameFromAuthAsync();
        }
        else
        {
            Error = "Guest sign-in failed.";
        }
        NotifyStateChanged();
    }

    private static string? GetDevUserFromQuery(string? queryString)
    {
        if (string.IsNullOrEmpty(queryString)) return null;
        queryString = queryString.TrimStart('?');
        var pairs = System.Web.HttpUtility.ParseQueryString(queryString);
        return pairs["user"];
    }

    // §5 of QA report: AutoGuestLogin now requires an explicit `?autoGuest=1` URL
    // parameter in addition to the server-side flag. This is a deliberate opt-in so
    // the silent bypass can never be hit by accident (e.g. bookmarked URL, deep link).
    private static bool IsAutoGuestOptIn(string? queryString)
    {
        if (string.IsNullOrEmpty(queryString)) return false;
        queryString = queryString.TrimStart('?');
        var pairs = System.Web.HttpUtility.ParseQueryString(queryString);
        var v = pairs["autoGuest"];
        return v == "1" || string.Equals(v, "true", StringComparison.OrdinalIgnoreCase);
    }

    public async Task SignInAsync()
    {
        if (_config?.DevLoginEnabled == true)
        {
            var profile = await _api.DevLoginAsync();
            if (profile != null)
            {
                Error = null;
                _user = profile;
            }
            else
            {
                Error = "Failed to sign in.";
            }
        }
        else if (_config?.MicrosoftEnabled == true)
        {
            // MSAL sign-in handled via JavaScript interop
            Error = "Microsoft sign-in requires JavaScript interop.";
        }

        NotifyStateChanged();
    }

    public async Task DevBypassAsync(string? userName = null)
    {
        if (!IsConfigured || !_config!.DevLoginEnabled)
        {
            Error = "Developer bypass not available.";
            NotifyStateChanged();
            return;
        }

        var profile = await _api.DevBypassAsync(userName);
        if (profile != null)
        {
            Error = null;
            _user = profile;
            // §10: keep the local player-name in sync with the new identity
            // so /profile and the bottom-tab bar show the new name immediately,
            // not the previously-cached "Player" / random adjective-noun.
            // SetPlayerNameFromAuth ignores empty values, which is what we want
            // when the user typed a real name (DisplayName is non-empty).
            // We wait for PlayerNameService.InitializeAsync first so the auth
            // value wins the localStorage race instead of being overwritten by
            // a randomly generated adjective-noun fallback.
            await _playerName.Initialized;
            if (!string.IsNullOrWhiteSpace(profile.DisplayName))
            {
                _playerName.SetPlayerNameFromAuth(profile.DisplayName);
            }
        }
        else
        {
            Error = "Developer bypass failed.";
        }

        NotifyStateChanged();
    }

    public async Task SignOutAsync()
    {
        AccessToken = null;
        _user = null;
        _api.SetBearer(null);

        if (_config?.DevLoginEnabled == true)
            await _api.DevLogoutAsync();

        if (_config?.MicrosoftEnabled == true && _msalInitialized)
        {
            try { await _js.InvokeVoidAsync("poAuth.signOut"); }
            catch { /* best-effort */ }
        }

        NotifyStateChanged();
    }

    public void SetUser(AuthenticatedUserProfile? user)
    {
        _user = user;
        NotifyStateChanged();
    }

    /// <summary>
    /// Push <see cref="AuthenticatedUserProfile.DisplayName"/> into
    /// <see cref="PlayerNameService"/> so the GameShell "Player" slot, the
    /// per-game stats file, and the right-rail auth identity all show the
    /// same name. Waits for <c>PlayerNameService.Initialized</c> so a server-
    /// derived display name wins over the locally-minted random fallback.
    /// </summary>
    private async Task SyncPlayerNameFromAuthAsync()
    {
        if (_user is null || string.IsNullOrWhiteSpace(_user.DisplayName)) return;
        await _playerName.Initialized;
        _playerName.SetPlayerNameFromAuth(_user.DisplayName);
    }

    private void NotifyStateChanged() => StateChanged?.Invoke();
}
