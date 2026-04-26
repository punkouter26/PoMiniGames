namespace PoMiniGamesClient.Services;

public class PlayerNameService
{
    private const string StorageKey = "pomini_player";
    private static readonly string[] Adjectives = ["Swift", "Bold", "Brave", "Cool", "Fast", "Wild", "Sharp", "Calm", "Sly", "Keen"];
    private static readonly string[] Nouns = ["Fox", "Bear", "Wolf", "Hawk", "Panda", "Tiger", "Lynx", "Raven", "Otter", "Gecko"];

    private string _playerName = string.Empty;

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

    public PlayerNameService()
    {
        _playerName = ReadInitialName();
    }

    public void SetPlayerName(string name)
    {
        var trimmed = string.IsNullOrWhiteSpace(name) ? "Player" : name.Trim();
        PlayerName = trimmed;
        PersistName(trimmed);
    }

    public void SetPlayerNameFromAuth(string name)
    {
        var trimmed = name.Trim();
        if (string.IsNullOrEmpty(trimmed)) return;
        PlayerName = trimmed;
        PersistName(trimmed);
    }

    private static string GenerateRandomName()
    {
        var adj = Adjectives[Random.Shared.Next(Adjectives.Length)];
        var noun = Nouns[Random.Shared.Next(Nouns.Length)];
        var num = Random.Shared.Next(1, 100);
        return $"{adj}{noun}{num}";
    }

    private static string ReadInitialName()
    {
        try
        {
            // This runs in the browser via JS interop
            return "Player";
        }
        catch
        {
            var generated = GenerateRandomName();
            return generated;
        }
    }

    public string GetOrReadInitialName()
    {
        if (_playerName == "Player")
        {
            var generated = GenerateRandomName();
            _playerName = generated;
            PersistName(generated);
        }
        return _playerName;
    }

    private static void PersistName(string name)
    {
        try
        {
            // localStorage handled via JS interop
        }
        catch
        {
            // ignore
        }
    }
}