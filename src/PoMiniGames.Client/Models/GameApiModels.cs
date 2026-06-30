namespace PoMiniGamesClient.Models;

// ---------------------------------------------------------------------------
// PoFunQuiz
// ---------------------------------------------------------------------------

/// <summary>A single trivia question returned by /api/funquiz/quiz/questions.</summary>
public class QuizQuestion
{
    public string Text { get; set; } = string.Empty;
    public List<string> Options { get; set; } = new();
    public int CorrectOptionIndex { get; set; }
    public string Category { get; set; } = "General";
    public int BasePoints { get; set; } = 2;
}

// ---------------------------------------------------------------------------
// PoFace
// ---------------------------------------------------------------------------

/// <summary>Status response from GET /api/face/status.</summary>
public class FaceStatusDto
{
    public string Game { get; set; } = "poface";
    public bool IsMockFaceApi { get; set; }
    public string Environment { get; set; } = string.Empty;
}

/// <summary>Session created by POST /api/face/sessions.</summary>
public class FaceSessionDto
{
    public string SessionId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public List<FaceRoundDto> Rounds { get; set; } = new();
}

/// <summary>A single round descriptor inside a <see cref="FaceSessionDto"/>.</summary>
public class FaceRoundDto
{
    public int RoundNumber { get; set; }
    public string TargetEmotion { get; set; } = string.Empty;
}

/// <summary>Leaderboard entry returned by GET /api/face/leaderboard.</summary>
public class FaceLeaderboardEntryDto
{
    public string UserId { get; set; } = string.Empty;
    public int Score { get; set; }
    public int Year { get; set; }
    public DateTime AchievedAt { get; set; }
}

/// <summary>Score result returned by POST /api/face/sessions/{id}/rounds/{n}/score.</summary>
public class FaceScoreResponse
{
    public string SessionId { get; set; } = string.Empty;
    public int RoundNumber { get; set; }
    public string TargetEmotion { get; set; } = string.Empty;
    public bool FaceDetected { get; set; }
    public float Confidence { get; set; }
    public bool HeadPoseValid { get; set; }
    public int Score { get; set; }
    public int TotalScore { get; set; }
    public string? ImageUrl { get; set; }
}

// ---------------------------------------------------------------------------
// PoCoupleQuiz
// ---------------------------------------------------------------------------

/// <summary>Team row returned by GET /api/couplequiz/teams.</summary>
public class CoupleQuizTeamRow
{
    public string Name { get; set; } = string.Empty;
    public int HighScore { get; set; }
    public int TotalQuestionsAnswered { get; set; }
    public int CorrectAnswers { get; set; }
    public DateTime LastPlayed { get; set; }
}
