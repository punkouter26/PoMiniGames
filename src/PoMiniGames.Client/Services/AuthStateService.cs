using Microsoft.JSInterop;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services;

public class AuthStateService
{
    private readonly ApiService _api;
    private readonly IJSRuntime _js;
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
    public bool DevLoginEnabled => _config?.DevLoginEnabled == true;
    public string? AccessToken { get; private set; }
    public string? Error { get; private set; }

    public event Action? StateChanged;

    public AuthStateService(ApiService api, IJSRuntime js)
    {
        _api = api;
        _js = js;
    }

    /// <summary>Wire format for the MSAL JS interop result (see wwwroot/js/poauth.js).</summary>
    private sealed record MsalResult(string Name, string Username, string? AccessToken);

    public async Task InitializeAsync(string? queryString = null)
    {
        _initialized = false;
        Error = null;
        NotifyStateChanged();

        var config = await _api.GetAuthConfigurationAsync();
        _config = config;

        if (config == null || !config.Enabled)
        {
            AccessToken = null;
            _user = null;
            _initialized = true;
            NotifyStateChanged();
            return;
        }

        if (config.DevLoginEnabled)
        {
            AccessToken = null;

            // Check for ?user= query param
            var urlUser = GetDevUserFromQuery(queryString);
            if (!string.IsNullOrEmpty(urlUser))
            {
                var profile = await _api.DevBypassAsync(urlUser);
                _user = profile;
                _initialized = true;
                NotifyStateChanged();
                return;
            }

            // Check existing session
            var existing = await _api.GetAuthenticatedUserAsync();
            if (existing != null)
            {
                _user = existing;
                _initialized = true;
                NotifyStateChanged();
                return;
            }

            // Test harness: silently sign in as Guest so browser tests skip the login wall.
            if (config.AutoGuestLogin)
            {
                _user = await _api.DevBypassAsync("Guest");
                _initialized = true;
                NotifyStateChanged();
                return;
            }

            // No session — the login screen will offer Microsoft + Guest.
            _user = null;
            _initialized = true;
            NotifyStateChanged();
            return;
        }

        // Microsoft OAuth (MSAL) mode — try to silently restore an existing session.
        if (config.MicrosoftEnabled)
        {
            try
            {
                await EnsureMsalInitializedAsync();
                var restored = await _js.InvokeAsync<MsalResult?>("poAuth.tryRestore", config.Scope);
                if (restored is not null)
                {
                    await ApplyMicrosoftSessionAsync(restored);
                }
            }
            catch
            {
                // No silent session available; the login screen will offer Microsoft sign-in.
            }
        }

        _initialized = true;
        NotifyStateChanged();
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
                    Error = "Sign-in was cancelled.";
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
        var profile = await _api.DevBypassAsync("Guest");
        if (profile != null) _user = profile;
        else Error = "Guest sign-in failed.";
        NotifyStateChanged();
    }

    private static string? GetDevUserFromQuery(string? queryString)
    {
        if (string.IsNullOrEmpty(queryString)) return null;
        queryString = queryString.TrimStart('?');
        var pairs = System.Web.HttpUtility.ParseQueryString(queryString);
        return pairs["user"];
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

    private void NotifyStateChanged() => StateChanged?.Invoke();
}
