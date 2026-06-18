using Azure.Data.Tables;

namespace PoMiniGames.Infrastructure.Services;

/// <summary>
/// Everything that varies between one game's high-score table and another's, captured as data:
/// where rows live (<see cref="Table"/> / <see cref="Partition"/>), how an entry is normalised
/// (<see cref="Sanitize"/>), how it maps to and from a <see cref="TableEntity"/>
/// (<see cref="ToFields"/> / <see cref="FromEntity"/>), and how a leaderboard is ranked
/// (<see cref="Rank"/>). The generic save/get flow in <see cref="StorageService"/> is identical
/// for every game; only this descriptor changes.
/// </summary>
/// <remarks>
/// Pattern: Strategy. Each game supplies a descriptor as the strategy; one generic persistence
/// algorithm consumes it. Adding a game becomes one descriptor instead of a new pair of
/// near-duplicate methods, concentrating the persistence contract in a single place.
/// </remarks>
internal sealed record HighScoreDescriptor<T>(
    string Table,
    string Partition,
    Func<T, T> Sanitize,
    Func<T, IDictionary<string, object?>> ToFields,
    Func<TableEntity, T> FromEntity,
    Func<IEnumerable<T>, IEnumerable<T>> Rank);
