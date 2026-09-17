using System.Text.Json;
using Blazored.LocalStorage;
using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Games.PoCabinet;

/// <summary>
/// Player's career progression for PoCabinet's 3-stage championship. Stored
/// locally in <c>localStorage</c> via Blazored.LocalStorage's <c>*AsString</c>
/// methods (the framework's preference — see Program.cs — the generic overloads
/// go through reflection-based JSON that the trim analyzer rejects).
///
/// <para>
/// Cross-device sync: when the player signs in, an authenticated <c>PUT</c> to
/// <c>/api/pocabinet/career</c> mirrors the same state server-side so they can
/// resume on a different device. Server <see cref="PoCabinetCareerDto"/> is the
/// authoritative shape; this class serializes to it via <see cref="System.Text.Json"/>.
/// </para>
/// </summary>
public sealed class PoCabinetCareerState
{
    private const string StorageKey = "pocabinet.career.v1";

    private readonly ILocalStorageService _storage;

    public PoCabinetCareerState(ILocalStorageService storage) => _storage = storage;

    /// <summary>Current state (loaded from storage, or fresh state if none).</summary>
    public PoCabinetCareerDto Current { get; set; } = PoCabinetCareerDto.New();

    /// <summary>True if storage I/O is available — false means no persistence this session.</summary>
    public bool StorageAvailable { get; private set; }

    public async Task LoadAsync()
    {
        try
        {
            var raw = await _storage.GetItemAsStringAsync(StorageKey);
            if (string.IsNullOrWhiteSpace(raw)) { StorageAvailable = true; return; }
            // Source-generated serializer (PoCabinetJsonContext) is trim-safe and the
            // framework requires it — see IL2026 in CLAUDE.md trim-audit notes.
            var parsed = JsonSerializer.Deserialize(raw, PoCabinetJsonContext.Default.PoCabinetCareerDto);
            if (parsed is not null) Current = parsed;
            StorageAvailable = true;
        }
        catch
        {
            // Storage unavailable (private mode, quota, etc.) — fall back to in-memory.
            StorageAvailable = false;
        }
    }

    public async Task SaveAsync()
    {
        if (!StorageAvailable) return;
        try
        {
            Current.UpdatedAtUtc = DateTimeOffset.UtcNow;
            var json = JsonSerializer.Serialize(Current, PoCabinetJsonContext.Default.PoCabinetCareerDto);
            await _storage.SetItemAsStringAsync(StorageKey, json);
        }
        catch
        {
            // ignore — already-in-memory is the fallback
        }
    }

    /// <summary>Advance to the next stage if a top-3 finish is reported.</summary>
    public async Task RecordStageResultAsync(int stageIndex, int finishPosition, bool isFinalRace)
    {
        if (finishPosition <= 3 && stageIndex == Current.CurrentStageIndex)
        {
            if (!Current.CompletedStages.Contains(stageIndex))
                Current.CompletedStages = Current.CompletedStages.Append(stageIndex).ToList();
            Current.CurrentStageIndex = Math.Min(stageIndex + 1, 2);
            if (isFinalRace && finishPosition == 1)
            {
                Current.TrophyUnlocked = true;
                Current.GoldLiveryUnlocked = true;
            }
            await SaveAsync();
        }
    }

    /// <summary>Reset to fresh state (for "Restart Career" UI flow).</summary>
    public async Task ResetAsync()
    {
        Current = PoCabinetCareerDto.New();
        await SaveAsync();
    }
}