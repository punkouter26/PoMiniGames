using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker;

/// <summary>
/// Abstraction over the JokeAPI external HTTP service.
/// Repository pattern (GoF): isolates the data-access concern of fetching jokes.
/// </summary>
public interface IJokeApiClient
{
    Task<JokeDto> FetchJokeAsync(
        bool safeMode = false,
        IEnumerable<int>? excludeIds = null,
        string category = "Any",
        CancellationToken cancellationToken = default);
}

/// <summary>Service contract for AI joke analysis and punchline prediction.</summary>
public interface IAnalysisService
{
    Task<(JokeAnalysisDto Analysis, JokeRatingDto Rating)> AnalyzeJokeAsync(
        JokeDto joke,
        CancellationToken cancellationToken = default);

    /// <summary>Returns a two-sentence explanation of the comedic mechanism of the given joke.</summary>
    Task<string> ExplainJokeAsync(
        JokeDto joke,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Turns a flagged joke into a clean one that keeps its comic shape, so it can be
/// performed rather than skipped.
/// </summary>
public interface IJokeRewriteService
{
    /// <summary>
    /// Returns a rewritten joke, or <c>null</c> when no rewrite could be produced —
    /// model unavailable, timed out, content-filtered, refused, or unparseable. The
    /// caller is expected to fall back rather than treat null as an error.
    /// </summary>
    Task<JokeDto?> TryRewriteAsync(JokeDto joke, CancellationToken cancellationToken = default);
}

/// <summary>
/// Repository contract for persisting and querying joke performance data.
/// Repository pattern (GoF/DDD): abstracts storage so the feature is decoupled from
/// Azure Table Storage implementation details.
/// </summary>
public interface IJokeStorageClient
{
    Task SavePerformanceAsync(JokePerformanceDto performance, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<JokePerformanceDto>> GetSessionPerformancesAsync(string sessionId, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<LeaderboardEntryDto>> GetLeaderboardAsync(int top = 10, CancellationToken cancellationToken = default);
}
