using System.Collections.Concurrent;

namespace PoMiniGamesClient.Games.PoRunner;

public class PoRunnerGameState
{
    public PoRunnerGameMode Mode { get; set; } = PoRunnerGameMode.OnePlayer;
    public string? ConnectionId { get; set; }
    public string ConnectionError { get; set; } = string.Empty;
    public Dictionary<string, ServerPlayer> ServerPlayers { get; set; } = new();
    public GameStatus GameStatus { get; set; } = GameStatus.Waiting;
    public long CountdownStartTimeMs { get; set; }
    public long RaceStartTimeMs { get; set; }
    public string FinishedPlayerId { get; set; } = string.Empty;
    public long LastRaceTimeMs { get; set; }
    public bool RaceTimedOut { get; set; }
    public List<HighScoreEntry> TopScores { get; set; } = new();
    public bool QualifiesForHighScore { get; set; }
    public bool InitialsFormShown { get; set; }
    public long InitialsFormAvailableAtMs { get; set; }
    public bool LeaderboardExpanded { get; set; }
    public int ComboIndex { get; set; }
    public int ComboIndex2 { get; set; }
    public bool HintDismissed { get; set; }
    public LocalSprite LocalSprite { get; set; } = new();
    public LocalSprite LocalSprite2 { get; set; } = new();
    public int TPoseFrame { get; set; }
    public List<ConfettiParticle> ConfettiParticles { get; set; } = new();
    public bool LocalCrossedFinish { get; set; }
    public long LocalFinishTimeMs { get; set; }
    public GameOverAnim? GameOverAnim { get; set; }
    public double CameraX { get; set; }
    public int WorldWidth { get; set; } = 1200;
    public double LastBeepSec { get; set; } = -1;
    public bool CountdownGunFired { get; set; }
    public bool AssetsLoaded { get; set; }
    public bool DemoMode { get; set; }
    public bool LocalCrossedFinish2 { get; set; }
    public long LocalFinishTimeMs2 { get; set; }

    public int FinishLineX => WorldWidth - PoRunnerConstants.StartLineX;
}

public class PoRunnerProfileService
{
    private const string ProfileKey = "porunner_profile";

    public PlayerProfile GetProfile()
    {
        try
        {
            var raw = System.Text.Json.JsonSerializer.Deserialize<PlayerProfile>(
                System.Text.Json.JsonSerializer.Serialize(new { }));
            if (System.Text.Json.JsonSerializer.Deserialize<PlayerProfile>(
                System.Text.Json.JsonSerializer.Serialize(new { })) == null)
            {
                return new PlayerProfile();
            }
            // For now, return default - localStorage would need JS interop
            return new PlayerProfile();
        }
        catch
        {
            return new PlayerProfile();
        }
    }

    public void SaveProfile(PlayerProfile profile)
    {
        // Would need JS interop to save to localStorage
    }
}

public class PoRunnerSoundService
{
    private SoundTheme _currentTheme = SoundTheme.Default;

    public SoundTheme GetTheme() => _currentTheme;

    public void SetTheme(SoundTheme theme)
    {
        _currentTheme = theme;
    }

    public SoundTheme CycleTheme()
    {
        var themes = Enum.GetValues<SoundTheme>();
        var currentIndex = Array.IndexOf(themes, _currentTheme);
        var nextIndex = (currentIndex + 1) % themes.Length;
        _currentTheme = themes[nextIndex];
        return _currentTheme;
    }

    public void SetRandomTheme()
    {
        var random = new Random();
        var themes = new[] { SoundTheme.Default, SoundTheme.Jungle, SoundTheme.Retro };
        _currentTheme = themes[random.Next(themes.Length)];
    }

    public void PlaySound(string type)
    {
        // Web Audio would be implemented via JS interop
    }
}
