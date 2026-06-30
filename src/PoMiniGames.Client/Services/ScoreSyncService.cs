using System.Text.Json;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services;

/// <summary>The kind of server board a queued score targets — drives which submit path the flusher uses.</summary>
public enum PendingScoreKind
{
    Snake,
    MarbleRace
}

/// <summary>
/// One score that could not reach the server and is parked in localStorage until connectivity returns.
/// The payload is stored as JSON so a single queue can hold every board's wire shape.
/// </summary>
public sealed class PendingScore
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public PendingScoreKind Kind { get; set; }
    public string PayloadJson { get; set; } = "";
    public string EnqueuedAt { get; set; } = "";
    public int Attempts { get; set; }
}

/// <summary>
/// localStorage-backed durable queue of unsynced scores. Pure persistence — no network. Kept separate
/// from <see cref="ScoreSyncService"/> so the "where it lives" concern is isolated from "when it flushes".
/// </summary>
public sealed class PendingScoreStore
{
    private const string StorageKey = "pomini_pending_scores";

    public List<PendingScore> Load() =>
        LocalStorageService.GetItem<List<PendingScore>>(StorageKey) ?? [];

    public void Save(List<PendingScore> items) =>
        LocalStorageService.SetItem(StorageKey, items);
}

/// <summary>
/// Makes the on-screen "scores will sync later" promise true. When a board submit fails, the score is
/// enqueued durably; on app start and whenever the API is reachable again, the queue is flushed in order.
/// This is the resilience layer the leaderboard North Star depends on.
/// </summary>
public sealed class ScoreSyncService
{
    private readonly ApiService _api;
    private readonly PendingScoreStore _store;
    private bool _flushing;

    public ScoreSyncService(ApiService api, PendingScoreStore store)
    {
        _api = api;
        _store = store;
    }

    /// <summary>Raised whenever the pending count changes so UI (the sync pill) can react.</summary>
    public event Action? Changed;

    public int PendingCount => _store.Load().Count;

    public void EnqueueSnake(SnakeHighScore entry) =>
        Enqueue(PendingScoreKind.Snake, JsonSerializer.Serialize(entry, ApiJsonContext.Default.SnakeHighScore));

    public void EnqueueMarbleRace(MarbleRaceHighScore entry) =>
        Enqueue(PendingScoreKind.MarbleRace, JsonSerializer.Serialize(entry, ApiJsonContext.Default.MarbleRaceHighScore));

    private void Enqueue(PendingScoreKind kind, string payloadJson)
    {
        var items = _store.Load();
        items.Add(new PendingScore
        {
            Kind = kind,
            PayloadJson = payloadJson,
            EnqueuedAt = DateTime.UtcNow.ToString("O"),
        });
        _store.Save(items);
        Changed?.Invoke();
    }

    /// <summary>
    /// Attempts to resubmit every queued score in FIFO order. Succeeded entries are dropped; entries that
    /// still fail stay queued (attempt count bumped) for the next flush. Re-entrant calls are ignored so a
    /// startup flush and a reconnect flush can't double-submit. Returns the number of scores synced.
    /// </summary>
    public async Task<int> FlushAsync()
    {
        if (_flushing) return 0;

        var items = _store.Load();
        if (items.Count == 0) return 0;

        // Don't hammer the network per-item when the backend is plainly down.
        if (!await _api.IsAvailableAsync()) return 0;

        _flushing = true;
        var synced = 0;
        try
        {
            var remaining = new List<PendingScore>(items.Count);
            foreach (var item in items)
            {
                bool ok;
                try
                {
                    ok = await SubmitAsync(item);
                }
                catch
                {
                    ok = false;
                }

                if (ok)
                {
                    synced++;
                }
                else
                {
                    item.Attempts++;
                    remaining.Add(item);
                }
            }

            _store.Save(remaining);
        }
        finally
        {
            _flushing = false;
        }

        if (synced > 0) Changed?.Invoke();
        return synced;
    }

    private async Task<bool> SubmitAsync(PendingScore item) => item.Kind switch
    {
        PendingScoreKind.Snake =>
            await _api.SubmitSnakeHighScoreAsync(
                JsonSerializer.Deserialize(item.PayloadJson, ApiJsonContext.Default.SnakeHighScore) ?? new SnakeHighScore()) is not null,
        PendingScoreKind.MarbleRace =>
            await _api.SubmitMarbleRaceHighScoreAsync(
                JsonSerializer.Deserialize(item.PayloadJson, ApiJsonContext.Default.MarbleRaceHighScore) ?? new MarbleRaceHighScore()) is not null,
        _ => true, // unknown kind: drop rather than wedge the queue forever
    };
}
