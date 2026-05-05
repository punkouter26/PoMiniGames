namespace PoMiniGames.Application.Diagnostics;

public interface IDiagnosticsSnapshotProvider
{
    Task<Dictionary<string, object?>> BuildSnapshotAsync(CancellationToken cancellationToken = default);
}
