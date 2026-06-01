using Microsoft.JSInterop;

namespace PoMiniGamesClient.Services;

public class PlayerNameService
{
    private const string StorageKey = "pomini_player";
    private static readonly string[] Adjectives = ["Swift", "Bold", "Brave", "Cool", "Fast", "Wild", "Sharp", "Calm", "Sly", "Keen"];
    private static readonly string[] Nouns = ["Fox", "Bear", "Wolf", "Hawk", "Panda", "Tiger", "Lynx", "Raven", "Otter", "Gecko"];

    private string _playerName = string.Empty;
    private IJSRuntime? _jsRuntime;

    public string PlayerName
    {
        get => _playerName;
        private set
        {
            if (_playerName != value)
            {
                _playerName = value;
                StateChanged?.Invoke();
            }
        }
    }

    public event Action? StateChanged;

    public PlayerNameService(IJSRuntime jsRuntime)
    {
        _jsRuntime = jsRuntime;
        _ = InitializeAsync();
    }

    public async Task InitializeAsync()
    {
        try
        {
            if (_jsRuntime is not null)
            {
                _playerName = await GetItemAsync<string>(StorageKey) ?? "Player";
                if (string.IsNullOrEmpty(_playerName) || _playerName == "Player")
                {
                    var generated = GenerateRandomName();
                    _playerName = generated;
                    await SetItemAsync(StorageKey, generated);
                }
                StateChanged?.Invoke();
                return;
            }
        }
        catch
        {
            // JS interop not available (e.g. pre-render)
        }
        _playerName = "Player";
    }

    public void SetPlayerName(string name)
    {
        var trimmed = string.IsNullOrWhiteSpace(name) ? "Player" : name.Trim();
        PlayerName = trimmed;
        _ = PersistName(trimmed);
    }

    public void SetPlayerNameFromAuth(string name)
    {
        var trimmed = name.Trim();
        if (string.IsNullOrEmpty(trimmed)) return;
        PlayerName = trimmed;
        _ = PersistName(trimmed);
    }

    private static string GenerateRandomName()
    {
        var adj = Adjectives[Random.Shared.Next(Adjectives.Length)];
        var noun = Nouns[Random.Shared.Next(Nouns.Length)];
        var num = Random.Shared.Next(1, 100);
        return $"{adj}{noun}{num}";
    }

    public string GetPlayerName() => PlayerName;

    public string GetOrReadInitialName()
    {
        if (_playerName == "Player" || string.IsNullOrEmpty(_playerName))
        {
            var generated = GenerateRandomName();
            _playerName = generated;
            _ = PersistName(generated);
        }
        return _playerName;
    }

    private async Task PersistName(string name)
    {
        try
        {
            if (_jsRuntime is not null)
            {
                await SetItemAsync(StorageKey, name);
            }
        }
        catch
        {
            // ignore
        }
    }

    private async Task<T?> GetItemAsync<T>(string key)
    {
        if (_jsRuntime == null) return default;
        try
        {
            // For string types, read raw and strip JSON encoding if present
            if (typeof(T) == typeof(string))
            {
                var raw = await _jsRuntime.InvokeAsync<string>("window.localStorage.getItem", key);
                if (raw is null) return default;
                // If the stored value is a JSON-encoded string (e.g. "\"CalmTiger42\""), decode it
                if (raw.Length >= 2 && raw[0] == '"' && raw[^1] == '"')
                {
                    try
                    {
                        return (T)(object)System.Text.Json.JsonSerializer.Deserialize<string>(raw)!;
                    }
                    catch { /* fall through to raw */ }
                }
                return (T)(object)raw;
            }
            return await _jsRuntime.InvokeAsync<T>("window.localStorage.getItem", key);
        }
        catch
        {
            return default;
        }
    }

    private async Task SetItemAsync<T>(string key, T value)
    {
        if (_jsRuntime == null) return;
        try
        {
            // For string values, store the raw string to avoid double-encoding on read
            if (value is string s)
            {
                await _jsRuntime.InvokeVoidAsync("window.localStorage.setItem", key, s);
            }
            else
            {
                var json = System.Text.Json.JsonSerializer.Serialize(value);
                await _jsRuntime.InvokeVoidAsync("window.localStorage.setItem", key, json);
            }
        }
        catch { }
    }
}
