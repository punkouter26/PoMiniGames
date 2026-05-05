using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services;

public class AuthStateService
{
    private readonly ApiService _api;
    private AuthClientConfiguration? _config;
    private AuthenticatedUserProfile? _user;
    private bool _initialized;

    public AuthClientConfiguration? Config => _config;
    public AuthenticatedUserProfile? User => _user;
    public bool IsConfigured => _config?.Enabled == true;
    public bool IsAuthenticated => _user != null;
    public bool IsLoading => !_initialized;
    public string? AccessToken { get; private set; }
    public string? Error { get; private set; }

    public event Action? StateChanged;

    public AuthStateService(ApiService api)
    {
        _api = api;
    }

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

            // No session
            _user = null;
            _initialized = true;
            NotifyStateChanged();
            return;
        }

        // MSAL mode - try to get existing user
        try
        {
            var msalUser = await _api.GetAuthenticatedUserAsync(AccessToken);
            _user = msalUser;
        }
        catch
        {
            Error = "Failed to authenticate.";
        }

        _initialized = true;
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

        if (_config?.DevLoginEnabled == true)
            await _api.DevLogoutAsync();

        NotifyStateChanged();
    }

    public void SetUser(AuthenticatedUserProfile? user)
    {
        _user = user;
        NotifyStateChanged();
    }

    private void NotifyStateChanged() => StateChanged?.Invoke();
}
