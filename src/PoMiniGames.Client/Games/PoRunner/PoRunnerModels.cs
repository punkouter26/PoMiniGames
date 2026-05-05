namespace PoMiniGamesClient.Games.PoRunner;

public class ServerPlayer
{
    public string Id { get; set; } = string.Empty;
    public double X { get; set; }
    public int Y { get; set; }
    public PlayerDirection Direction { get; set; } = PlayerDirection.East;
    public PlayerAction Action { get; set; } = PlayerAction.Idle;
    public int CurrentFrame { get; set; }
    public string ColorTint { get; set; } = "yellow";
    public bool IsReady { get; set; }
}

public class LocalSprite
{
    public PlayerAction Action { get; set; } = PlayerAction.Idle;
    public int Frame { get; set; }
    public double FrameTimer { get; set; }
}

public class ConfettiParticle
{
    public double X { get; set; }
    public double Y { get; set; }
    public double Vx { get; set; }
    public double Vy { get; set; }
    public string Color { get; set; } = "#fcd34d";
    public double Width { get; set; }
    public double Height { get; set; }
    public double Rotation { get; set; }
    public double RotationSpeed { get; set; }
    public double Life { get; set; } = 1.0;
    public double Decay { get; set; } = 0.003;
}

public class GameOverAnim
{
    public double SpriteX { get; set; } = -300;
    public int Frame { get; set; }
    public double FrameTimer { get; set; }
    public bool WinnerIsTPose { get; set; }
    public bool LoserIsTPose { get; set; }
    public bool LoserExists { get; set; }
    public bool Done { get; set; }
}

public class DemoBot
{
    public string Id { get; set; } = string.Empty;
    public double BaseSpeed { get; set; }
    public double CurrentSpeed { get; set; }
    public double BurstTimer { get; set; }
    public double FrameTimer { get; set; }
    public int WalkFrame { get; set; }
    public bool Finished { get; set; }
}

public class HighScoreEntry
{
    public int Rank { get; set; }
    public long TimeMs { get; set; }
    public string Initials { get; set; } = string.Empty;
}

public class PlayerProfile
{
    public string Initials { get; set; } = string.Empty;
    public long? PersonalBestMs { get; set; }
    public int Wins { get; set; }
    public int Losses { get; set; }
    public int WinStreak { get; set; }
    public int CurrentStreak { get; set; }
}
