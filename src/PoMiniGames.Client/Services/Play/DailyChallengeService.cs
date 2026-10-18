using System.Globalization;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services.Play;

/// <summary>Today's game: the same one for every player on the same UTC day.</summary>
/// <param name="Day">The UTC date as a yyyyMMdd number, which is also the seed handed to the game.</param>
/// <param name="Seeded">True when the game's page reads <c>?daily=</c> and runs its own seeded daily.</param>
public sealed record DailyPick(CatalogGame Game, CatalogMode Mode, int Day, bool Seeded)
{
    /// <summary>The launch URL: the solo mode, plus <c>daily=yyyyMMdd</c> where the game can seed from it.</summary>
    public string Url => Seeded
        ? $"{Mode.Url}{(Mode.Url.Contains('?') ? '&' : '?')}daily={Day.ToString(CultureInfo.InvariantCulture)}"
        : Mode.Url;
}

/// <summary>The cross-game daily streak: the last day played, the run it is on, and the best run.</summary>
public readonly record struct DailyStreak(int LastDay, int Current, int Best);

/// <summary>
/// The hub's "Today" card. One game a day, picked by hashing the UTC date over the solo games that
/// run without a server, so everyone gets the same pick and it works offline. Launching it keeps a
/// streak that spans every game, kept in localStorage.
/// </summary>
/// <remarks>
/// A day number is the seed, and the streak grows when yesterday was played too.
/// Public and registered so the Profile page can show the streak.
/// </remarks>
public sealed class DailyChallengeService
{
    private const string StorageKey = "pomini_daily_streak";

    // Games whose solo page turns ?daily= into its own seeded daily run (PoVoxelStrike's Daily
    // Siege). Everything else is picked as a plain game. PoRacer needs no parameter: its weather
    // is already seeded per UTC day.
    private static readonly HashSet<GameKey> SeededGames = [GameKeys.PoVoxelStrike];

    // Solo modes with nothing to beat: a watched island and a sand toy are not a challenge.
    private static readonly HashSet<GameKey> NotAChallenge = [GameKeys.PoEcosystem, GameKeys.SandPlayground];

    /// <summary>Every game the pick can land on, in catalog order (the order is part of the hash's meaning).</summary>
    public static IReadOnlyList<CatalogGame> Pool { get; } =
    [
        .. GameCatalog.All.Where(g =>
            g.Find(GameMode.OnePlayer) is { RequiresNetwork: false } && !NotAChallenge.Contains(g.Key)),
    ];

    /// <summary>Raised after the streak changes.</summary>
    public event Action? Changed;

    /// <summary>The UTC date as yyyyMMdd.</summary>
    public static int DayNumber(DateTime utc) => (utc.Year * 10000) + (utc.Month * 100) + utc.Day;

    /// <summary>The pick for the UTC day containing <paramref name="utcNow"/>.</summary>
    public static DailyPick PickFor(DateTime utcNow)
    {
        var day = DayNumber(utcNow);
        var game = Pool[(int)(Fnv1a("po-daily-" + day.ToString(CultureInfo.InvariantCulture)) % (uint)Pool.Count)];
        return new DailyPick(game, game.Find(GameMode.OnePlayer)!, day, SeededGames.Contains(game.Key));
    }

    /// <summary>
    /// The streak after playing on <paramref name="utcToday"/>: unchanged if today already counted,
    /// one longer if yesterday was played, otherwise a fresh run of one.
    /// </summary>
    public static DailyStreak Advance(DailyStreak streak, DateTime utcToday)
    {
        var today = DayNumber(utcToday);
        if (streak.LastDay == today) return streak;
        var current = streak.LastDay == DayNumber(utcToday.AddDays(-1)) ? streak.Current + 1 : 1;
        return new DailyStreak(today, current, Math.Max(streak.Best, current));
    }

    /// <summary>The run still alive on <paramref name="utcToday"/>: a streak last played before yesterday is over.</summary>
    public static int LiveStreak(DailyStreak streak, DateTime utcToday) =>
        streak.LastDay == DayNumber(utcToday) || streak.LastDay == DayNumber(utcToday.AddDays(-1)) ? streak.Current : 0;

    /// <summary>Today's pick.</summary>
    public DailyPick Today => PickFor(DateTime.UtcNow);

    /// <summary>The streak as stored.</summary>
    public DailyStreak Streak => Parse(LocalStorageService.GetItem<string>(StorageKey));

    /// <summary>Days in a row up to today or yesterday; 0 once a day has been missed.</summary>
    public int CurrentStreak => LiveStreak(Streak, DateTime.UtcNow);

    /// <summary>The longest run ever kept in this browser.</summary>
    public int BestStreak => Streak.Best;

    /// <summary>Whether today's pick has already been launched.</summary>
    public bool DoneToday => Streak.LastDay == DayNumber(DateTime.UtcNow);

    /// <summary>Count today toward the streak. Called when the player launches today's pick.</summary>
    public void MarkPlayed()
    {
        var before = Streak;
        var after = Advance(before, DateTime.UtcNow);
        if (after == before) return;
        LocalStorageService.SetItem(StorageKey, string.Create(CultureInfo.InvariantCulture,
            $"{after.LastDay}|{after.Current}|{after.Best}"));
        Changed?.Invoke();
    }

    // "lastDay|current|best". A plain string, not JSON: it keeps the type out of the shared JSON
    // context, and a corrupt value reads as no streak rather than throwing.
    private static DailyStreak Parse(string? raw)
    {
        var parts = raw?.Split('|');
        if (parts is not { Length: 3 }) return default;
        var ok = int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var day)
               & int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var current)
               & int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var best);
        return ok ? new DailyStreak(day, current, Math.Max(best, current)) : default;
    }

    private static uint Fnv1a(string text)
    {
        unchecked
        {
            var hash = 2166136261u;
            foreach (var c in text) hash = (hash ^ c) * 16777619u;
            return hash;
        }
    }
}
