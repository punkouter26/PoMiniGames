namespace PoMiniGamesClient.Games.PoRunner;

public static class PoRunnerConstants
{
    // Game modes
    public static PoRunnerGameMode DefaultMode = PoRunnerGameMode.OnePlayer;

    // Key combos for movement
    public static char[] ComboP1 = ['t', 'y', 'g', 'h'];
    public static char[] ComboP2 = ['q', 'w', 'e', 'r'];
    
    // Movement distance per combo
    public const int JumpPixels = 60;
    
    // Animation settings
    public const int WalkFps = 12;
    public const int BananaWalkFrames = 6;
    public const int TPoseWalkFrames = 8;
    
    // World geometry
    public const int StartLineX = 150;
    public const int MinWorldWidth = 1200;
    public const double GroundHeightRatio = 0.35;
    public const int PlayerBaseYOffset = 130;
    
    // Sprite scaling
    public const double BananaScale = 3.0;
    public const double TPoseScale = 1.8;
    
    // Camera settings
    public const int CameraSnapThreshold = 200;
    public const double CameraLerp = 0.1;
    
    // Confetti
    public const int ConfettiCount = 90;
    public static readonly string[] ConfettiColors = 
    {
        "#fcd34d", "#10b981", "#3b82f6", "#f87171", "#a78bfa", "#fb923c"
    };
    
    // UI timings
    public const int InitialsFormDelayMs = 1000;
    public const int MaxRaceDurationMs = 20000;
    public const int CountdownDurationMs = 3000;
    
    // Player colors
    public static readonly Dictionary<string, string> PlayerColorMap = new()
    {
        ["yellow"] = "#fcd34d",
        ["blue"] = "#3b82f6",
        ["red"] = "#ef4444",
        ["green"] = "#22c55e",
        ["purple"] = "#a855f7",
        ["orange"] = "#f97316",
        ["pink"] = "#ec4899",
        ["teal"] = "#14b8a6"
    };
    
    // Color hue rotations for banana suit tinting
    public static readonly Dictionary<string, double> ColorHueRotate = new()
    {
        ["yellow"] = 0,
        ["red"] = -46,
        ["green"] = 96,
        ["purple"] = 225,
        ["orange"] = -21,
        ["pink"] = 284,
        ["teal"] = 128
    };
    
    // Demo mode
    public const int DemoBotCount = 8;
    public const double DemoSpeedMin = 60;
    public const double DemoSpeedMax = 130;
    public const double DemoBurstInterval = 1.5;
    public const double DemoBurstVariance = 0.35;
    public const int DemoAutoRestartDelayMs = 4000;
    
    // Game over animation
    public const double GameOverWalkSpeed = 200;
    public const double WinnerXRatio = 0.35;
    public const double LoserXRatio = 0.72;
    
    // Demo camera
    public const int DemoStartHoldMs = 1500;
}