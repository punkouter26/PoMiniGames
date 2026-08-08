namespace PoMiniGames.Shared.Games.PoJoker;

/// <summary>
/// Configuration settings for the jester performance loop timing.
/// Can be overridden via appsettings.json or environment variables.
/// </summary>
public class PerformanceSettings
{
    /// <summary>Duration of the joke setup narration in seconds. Default: 3.</summary>
    public int SetupDurationSeconds { get; set; } = 3;

    /// <summary>Duration of the AI prediction/analysis in seconds. Default: 2.</summary>
    public int PredictionDurationSeconds { get; set; } = 2;

    /// <summary>
    /// Hard cap on a single /api/joker/analyze round-trip in seconds. Exceeding it
    /// surfaces a shrug-line "the jester has nothing to add" instead of letting the
    /// demo stall on "Jester is thinking…". Default: 8.
    /// </summary>
    public int AnalysisTimeoutSeconds { get; set; } = 8;

    /// <summary>Delay before revealing the punchline in seconds. Default: 1.</summary>
    public int PunchlineDelaySeconds { get; set; } = 1;

    /// <summary>Duration for showing the punchline in seconds. Default: 5 - long enough for
    /// TTS to finish narrating the punchline and for the viewer to read the commentary.</summary>
    public int PunchlineDurationSeconds { get; set; } = 5;

    /// <summary>Transition delay between jokes in seconds. Default: 1.</summary>
    public int TransitionDurationSeconds { get; set; } = 1;

    /// <summary>Delay before retrying on failed API calls in milliseconds. Default: 2000.</summary>
    public int RetryDelayMilliseconds { get; set; } = 2000;

    /// <summary>Delay while polling for user interaction (resume, retry) in milliseconds. Default: 500.</summary>
    public int UserInteractionPollMilliseconds { get; set; } = 500;

    /// <summary>Validation method to ensure reasonable values.</summary>
    public void Validate()
    {
        if (SetupDurationSeconds < 0)
            throw new InvalidOperationException("SetupDurationSeconds must be >= 0");
        if (PredictionDurationSeconds < 0)
            throw new InvalidOperationException("PredictionDurationSeconds must be >= 0");
        if (AnalysisTimeoutSeconds <= 0)
            throw new InvalidOperationException("AnalysisTimeoutSeconds must be > 0");
        if (PunchlineDelaySeconds < 0)
            throw new InvalidOperationException("PunchlineDelaySeconds must be >= 0");
        if (PunchlineDurationSeconds < 0)
            throw new InvalidOperationException("PunchlineDurationSeconds must be >= 0");
        if (TransitionDurationSeconds < 0)
            throw new InvalidOperationException("TransitionDurationSeconds must be >= 0");
        if (RetryDelayMilliseconds < 0)
            throw new InvalidOperationException("RetryDelayMilliseconds must be >= 0");
        if (UserInteractionPollMilliseconds < 0)
            throw new InvalidOperationException("UserInteractionPollMilliseconds must be >= 0");
    }
}
