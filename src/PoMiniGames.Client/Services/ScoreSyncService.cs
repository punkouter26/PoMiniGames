using System.Text.Json;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services;

/// <summary>The kind of server board a queued score targets — drives which submit path the flusher uses.</summary>
public enum PendingScoreKind
{
    MarbleRace,
    PoBrawl,
    /// <summary>A PlayerStats PUT (adaptive-ELO games mirror their rating into it).</summary>
    PlayerStats
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

    public void EnqueueMarbleRace(MarbleRaceHighScoreRequest entry) =>
        Enqueue(PendingScoreKind.MarbleRace, JsonSerializer.Serialize(entry, ApiJsonContext.Default.MarbleRaceHighScoreRequest));

    public void EnqueuePoBrawl(PoBrawlHighScore entry) =>
        Enqueue(PendingScoreKind.PoBrawl, JsonSerializer.Serialize(entry, ApiJsonContext.Default.PoBrawlHighScore));

    public void EnqueuePlayerStats(PendingPlayerStats entry) =>
        Enqueue(PendingScoreKind.PlayerStats, JsonSerializer.Serialize(entry, ApiJsonContext.Default.PendingPlayerStats));

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
    /// Attempts to resubmit every queued score in FIFO order. Synced entries are dropped, and so are ones
    /// the server rejects outright — a payload the server refuses can only be refused again, so keeping it
    /// would replay the same rejection on every flush forever. Only entries that could still succeed stay
    /// queued (attempt count bumped). Re-entrant calls are ignored so a startup flush and a reconnect flush
    /// can't double-submit. Returns the number of scores synced.
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
                Disposition disposition;
                try
                {
                    disposition = await SubmitAsync(item);
                }
                catch
                {
                    disposition = Disposition.Retry;
                }

                switch (disposition)
                {
                    case Disposition.Synced:
                        synced++;
                        break;
                    case Disposition.Drop:
                        break;
                    default:
                        item.Attempts++;
                        remaining.Add(item);
                        break;
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

    /// <summary>What to do with a queued entry after attempting it.</summary>
    private enum Disposition { Synced, Retry, Drop }

    private async Task<Disposition> SubmitAsync(PendingScore item) => item.Kind switch
    {
        PendingScoreKind.MarbleRace => await SubmitMarbleRaceAsync(item.PayloadJson),
        PendingScoreKind.PoBrawl =>
            await _api.SubmitPoBrawlHighScoreAsync(
                JsonSerializer.Deserialize(item.PayloadJson, ApiJsonContext.Default.PoBrawlHighScore) ?? new PoBrawlHighScore()) is not null
                ? Disposition.Synced : Disposition.Retry,
        PendingScoreKind.PlayerStats => await SubmitPlayerStatsAsync(item.PayloadJson),
        _ => Disposition.Drop, // unknown kind: drop rather than wedge the queue forever
    };

    private async Task<Disposition> SubmitMarbleRaceAsync(string payloadJson)
    {
        // Entries queued before the submission shape narrowed to a bare score carry extra
        // properties; deserializing ignores them and keeps the score, so old queues still drain.
        var request = JsonSerializer.Deserialize(payloadJson, ApiJsonContext.Default.MarbleRaceHighScoreRequest);
        if (request is null) return Disposition.Drop; // malformed: unreplayable

        var result = await _api.SubmitMarbleRaceHighScoreAsync(request);
        if (result.IsSaved) return Disposition.Synced;
        return result.ShouldRetry ? Disposition.Retry : Disposition.Drop;
    }

    private async Task<Disposition> SubmitPlayerStatsAsync(string payloadJson)
    {
        var pending = JsonSerializer.Deserialize(payloadJson, ApiJsonContext.Default.PendingPlayerStats);
        if (pending is null || string.IsNullOrEmpty(pending.GameKey)) return Disposition.Drop; // malformed
        var (ok, _) = await _api.SavePlayerStatsAsync(pending.GameKey, pending.PlayerName, pending.Stats);
        return ok ? Disposition.Synced : Disposition.Retry;
    }
}
