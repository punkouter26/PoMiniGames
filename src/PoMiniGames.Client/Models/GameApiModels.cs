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

/// <summary>One ranked row on GET /api/funquiz/leaderboard. Mirrors the server's LeaderboardEntry.</summary>
public class FunQuizLeaderboardRow
{
    public string PlayerName { get; set; } = string.Empty;
    public int Score { get; set; }
    public int MaxStreak { get; set; }
    public string Category { get; set; } = "General";
    public DateTime DatePlayed { get; set; }
    public int Wins { get; set; }
    public int Losses { get; set; }
}

/// <summary>Body for POST /api/funquiz/leaderboard. The server overrides PlayerName
/// with the authenticated identity (email or anon-… marker); only Category + Score
/// are user-controllable. Score is clamped server-side to 0..10_000.</summary>
public class FunQuizLeaderboardSubmission
{
    public string Category { get; set; } = "General";
    public int Score { get; set; }
    public int MaxStreak { get; set; }
    public int Wins { get; set; }
    public int Losses { get; set; }
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

/// <summary>Recap of a completed/in-progress session returned by GET /api/face/sessions/{id}.</summary>
public class FaceRecapDto
{
    public string SessionId { get; set; } = string.Empty;
    public int TotalScore { get; set; }
    public bool IsComplete { get; set; }
    public List<FaceRecapRoundDto> Rounds { get; set; } = new();
}

/// <summary>A single saved round inside a <see cref="FaceRecapDto"/> — score, confidence, captured frame.</summary>
public class FaceRecapRoundDto
{
    public int RoundNumber { get; set; }
    public string TargetEmotion { get; set; } = string.Empty;
    public bool Captured { get; set; }
    public int Score { get; set; }
    public float Confidence { get; set; }
    public bool HeadPoseValid { get; set; }
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
