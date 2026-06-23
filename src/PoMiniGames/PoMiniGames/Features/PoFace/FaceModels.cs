namespace PoMiniGames.Features.PoFace;

// ── Domain types (pure, no I/O) ─────────────────────────────────────────────

/// <summary>Five facial emotions the game cycles through. Order is fixed per the 2026 design.</summary>
public enum TargetEmotion
{
    Happiness,
    Surprise,
    Anger,
    Sadness,
    Fear
}

/// <summary>Validates head pose; ±20° yaw + pitch per the 2026 design.</summary>
/// <remarks>Pure static — no I/O, no dependencies. Unit-testable in isolation.</remarks>
public static class HeadPoseValidator
{
    public const int MaxYawDegrees = 20;
    public const int MaxPitchDegrees = 20;

    public static bool Validate(float yawDegrees, float pitchDegrees) =>
        Math.Abs(yawDegrees) <= MaxYawDegrees && Math.Abs(pitchDegrees) <= MaxPitchDegrees;
}

public class RoundCapture
{
    public int RoundNumber { get; set; }
    public TargetEmotion TargetEmotion { get; set; }
    public float TargetEmotionConfidence { get; set; }
    public float Yaw { get; set; }
    public float Pitch { get; set; }
    public float Roll { get; set; }
    public bool HeadPoseValid { get; set; }
    public int Score { get; set; }
    public DateTime CapturedAt { get; set; } = DateTime.UtcNow;
}

public class GameSession
{
    public string SessionId { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    public List<RoundCapture> Captures { get; set; } = new();
    public int TotalScore => Captures.Sum(c => c.Score);
    public bool IsComplete { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ExpiresAt { get; set; }
}

public class LeaderboardEntry
{
    public string UserId { get; set; } = string.Empty;
    public int Score { get; set; } = 0;
    public int Year { get; set; } = DateTime.UtcNow.Year;
    public DateTime AchievedAt { get; set; } = DateTime.UtcNow;
}

public class PlayerStats
{
    public string UserId { get; set; } = string.Empty;
    public int TotalGames { get; set; }
    public int TotalScore { get; set; }
    public int BestScore { get; set; }
    public int HappinessBest { get; set; }
    public int SurpriseBest { get; set; }
    public int AngerBest { get; set; }
    public int SadnessBest { get; set; }
    public int FearBest { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public void RecordCompletedSession(GameSession session)
    {
        TotalGames++;
        TotalScore += session.TotalScore;
        if (session.TotalScore > BestScore) BestScore = session.TotalScore;
        foreach (var c in session.Captures)
        {
            var current = c.TargetEmotion switch
            {
                TargetEmotion.Happiness => HappinessBest,
                TargetEmotion.Surprise => SurpriseBest,
                TargetEmotion.Anger => AngerBest,
                TargetEmotion.Sadness => SadnessBest,
                TargetEmotion.Fear => FearBest,
                _ => 0
            };
            if (c.Score > current)
            {
                switch (c.TargetEmotion)
                {
                    case TargetEmotion.Happiness: HappinessBest = c.Score; break;
                    case TargetEmotion.Surprise: SurpriseBest = c.Score; break;
                    case TargetEmotion.Anger: AngerBest = c.Score; break;
                    case TargetEmotion.Sadness: SadnessBest = c.Score; break;
                    case TargetEmotion.Fear: FearBest = c.Score; break;
                }
            }
        }
        UpdatedAt = DateTime.UtcNow;
    }
}

/// <summary>The fixed 5-round order. Per the 2026 design, the order is NEVER shuffled.</summary>
public static class FaceRoundOrder
{
    public static readonly IReadOnlyList<TargetEmotion> Order = new[]
    {
        TargetEmotion.Happiness,
        TargetEmotion.Surprise,
        TargetEmotion.Anger,
        TargetEmotion.Sadness,
        TargetEmotion.Fear,
    };
}
