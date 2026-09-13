namespace PoMiniGames.Domain.Abstractions;

public interface IDiagnosticsSnapshotProvider
{
    Task<Dictionary<string, object?>> BuildSnapshotAsync(CancellationToken cancellationToken = default);
}
