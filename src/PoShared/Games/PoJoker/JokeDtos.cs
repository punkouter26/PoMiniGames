namespace PoShared.Games.PoJoker;

/// <summary>
/// Represents a joke with setup and punchline. Maps to JokeAPI response structure.
/// Ported from the standalone PoJoker app for the demo-only integration.
/// </summary>
public sealed record JokeDto
{
    /// <summary>Unique identifier for the joke from JokeAPI.</summary>
    public required int Id { get; init; }

    /// <summary>Category of the joke (e.g., "Programming", "Pun", "Dark").</summary>
    public string Category { get; init; } = "General";

    /// <summary>Type of joke: "twopart" (setup + punchline) or "single" (one-liner).</summary>
    public string Type { get; init; } = "single";

    /// <summary>The setup part of a two-part joke. Empty for single-type jokes.</summary>
    public string Setup { get; init; } = string.Empty;

    /// <summary>The punchline of a two-part joke. Empty for single-type jokes.</summary>
    public string Punchline { get; init; } = string.Empty;

    /// <summary>The complete joke text for single-type jokes. Empty for twopart jokes.</summary>
    public string Joke { get; init; } = string.Empty;

    /// <summary>Content flags indicating potentially sensitive content.</summary>
    public JokeFlags Flags { get; init; } = new();

    /// <summary>Whether safe mode was enabled when this joke was fetched.</summary>
    public bool SafeMode { get; init; }

    /// <summary>Gets the display text - either the setup or the single joke text.</summary>
    public string DisplayText => Type == "twopart" ? Setup : Joke;

    /// <summary>Gets the full joke text for display.</summary>
    public string FullText => Type == "twopart" ? $"{Setup}\n{Punchline}" : Joke;
}

/// <summary>Content flags from JokeAPI.</summary>
public sealed record JokeFlags
{
    public bool Nsfw { get; init; }
    public bool Religious { get; init; }
    public bool Political { get; init; }
    public bool Racist { get; init; }
    public bool Sexist { get; init; }
    public bool Explicit { get; init; }
}

/// <summary>Represents an AI punchline analysis result.</summary>
public sealed record JokeAnalysisDto
{
    /// <summary>Unique identifier for this analysis.</summary>
    public Guid Id { get; init; } = Guid.NewGuid();

    /// <summary>The original joke that was analyzed.</summary>
    public required JokeDto OriginalJoke { get; init; }

    /// <summary>The AI's predicted punchline.</summary>
    public required string AiPunchline { get; init; }

    /// <summary>The AI's confidence level in its prediction (0.0 - 1.0).</summary>
    public double Confidence { get; init; }

    /// <summary>Whether the AI's prediction matched the actual punchline.</summary>
    public bool IsTriumph { get; init; }

    /// <summary>Similarity score between AI prediction and actual punchline (0.0 - 1.0).</summary>
    public double SimilarityScore { get; init; }

    /// <summary>Time taken for AI to generate the prediction in milliseconds.</summary>
    public long LatencyMs { get; init; }

    /// <summary>Timestamp when the analysis was performed.</summary>
    public DateTimeOffset AnalyzedAt { get; init; } = DateTimeOffset.UtcNow;

    /// <summary>AI rating across multiple dimensions (Cleverness, Rudeness, Complexity, Difficulty).</summary>
    public JokeRatingDto? Rating { get; init; }
}

/// <summary>AI rating of a joke across multiple dimensions.</summary>
public sealed record JokeRatingDto
{
    /// <summary>Cleverness score (1-10). How witty and ingenious is the wordplay or concept?</summary>
    public int Cleverness { get; init; }

    /// <summary>Rudeness score (1-10). How inappropriate or edgy is the humor?</summary>
    public int Rudeness { get; init; }

    /// <summary>Complexity score (1-10). How complex is the joke structure or concept?</summary>
    public int Complexity { get; init; }

    /// <summary>Difficulty score (1-10). How hard is it to predict the punchline?</summary>
    public int Difficulty { get; init; }

    /// <summary>AI Jester's personality-driven commentary on the joke.</summary>
    public string Commentary { get; init; } = string.Empty;

    /// <summary>Average of all scores.</summary>
    public double Average => (Cleverness + Rudeness + Complexity + Difficulty) / 4.0;
}

/// <summary>Represents a complete joke performance (fetch + analysis cycle).</summary>
public sealed record JokePerformanceDto
{
    /// <summary>Unique identifier for this performance.</summary>
    public Guid Id { get; init; } = Guid.NewGuid();

    /// <summary>Session identifier grouping related performances.</summary>
    public required string SessionId { get; init; }

    /// <summary>The joke that was performed.</summary>
    public required JokeDto Joke { get; init; }

    /// <summary>The AI analysis of the joke.</summary>
    public required JokeAnalysisDto Analysis { get; init; }

    /// <summary>Sequence number within the session (1-based).</summary>
    public int SequenceNumber { get; init; }

    /// <summary>Whether this was a triumph (AI guessed correctly).</summary>
    public bool IsTriumph => Analysis.IsTriumph;

    /// <summary>Timestamp when the performance started.</summary>
    public DateTimeOffset StartedAt { get; init; }

    /// <summary>Timestamp when the performance completed.</summary>
    public DateTimeOffset CompletedAt { get; init; } = DateTimeOffset.UtcNow;

    /// <summary>Total duration of the performance in milliseconds.</summary>
    public long DurationMs => (long)(CompletedAt - StartedAt).TotalMilliseconds;

    /// <summary>State of the performance for UI display.</summary>
    public PerformanceState State { get; init; } = PerformanceState.Transitioning;
}

/// <summary>Leaderboard entry for high scores display.</summary>
public sealed record LeaderboardEntryDto
{
    /// <summary>Rank position on the leaderboard (1-based).</summary>
    public int Rank { get; init; }

    /// <summary>Session identifier.</summary>
    public required string SessionId { get; init; }

    /// <summary>Total jokes performed in the session.</summary>
    public int TotalJokes { get; init; }

    /// <summary>Number of AI triumphs.</summary>
    public int Triumphs { get; init; }

    /// <summary>Triumph rate as a decimal fraction (0.0–1.0). Use P1 format to display as percentage.</summary>
    public double TriumphRate { get; init; }

    /// <summary>Score calculated for ranking. Formula: (Triumphs * 100) + (TriumphRate * 1000).</summary>
    public double Score { get; init; }

    /// <summary>When the session was completed.</summary>
    public DateTimeOffset CompletedAt { get; init; }

    /// <summary>Whether this entry belongs to the current user's session.</summary>
    public bool IsCurrentSession { get; init; }
}

/// <summary>Response DTO for the Comedy Coach explain endpoint.</summary>
public sealed record JokeExplanationDto
{
    public required string Explanation { get; init; }
}
