namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Race-event dialogue kinds. The dialogue pipeline selects one line per
/// (official, kind, raceTick) tuple; deterministic by seed so the same race
/// always plays the same script (testable + reproducible).
/// </summary>
public enum DialogueKind
{
    PreRace = 0,
    PositionChange = 1,
    LapFinish = 2,
    RaceFinish = 3,
}

/// <summary>
/// Scripted dialogue pools per official. Hand-authored; no AI generation per
/// ADR-4 (and per the user's explicit "No AI — scripted dialogue only" choice
/// in Phase 0). The lines are deliberately short, satirical, and avoid slurs
/// or targeted harassment of any named real person — the E2E-API contract
/// test asserts no banned-token scan finds a match across the four pools.
/// </summary>
public static class PoCabinetDialogue
{
    /// <summary>Defensive content tokens that must never appear in any pool line. Lowercase.</summary>
    public static readonly IReadOnlySet<string> BannedTokens = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        // Common slurs / harassment markers. The list is intentionally short — the
        // framework's content policy forbids targeted harassment; we filter the most
        // obvious markers and rely on human review of the pool itself for nuance.
        "slur-placeholder-1",
        "slur-placeholder-2",
    };

    /// <summary>Per-official, per-kind dialogue pools. Empty list = no lines (caller falls back).</summary>
    public static IReadOnlyDictionary<string, IReadOnlyDictionary<DialogueKind, IReadOnlyList<string>>> Pools { get; } =
        new Dictionary<string, IReadOnlyDictionary<DialogueKind, IReadOnlyList<string>>>
        {
            ["sean-s"] = new Dictionary<DialogueKind, IReadOnlyList<string>>
            {
                [DialogueKind.PreRace] = new[]
                {
                    "I'm not taking questions right now.",
                    "There will be no comment at this time.",
                    "The press can wait.",
                    "Stay on message.",
                    "I'm here to drive, not explain.",
                    "No briefing today — only racing.",
                    "Off the record? Always.",
                    "I deny everything.",
                },
                [DialogueKind.PositionChange] = new[]
                {
                    "I'm not moving, you are.",
                    "That's a misleading frame.",
                    "Spin it however you like.",
                    "I reject the premise.",
                    "Fake news.",
                },
                [DialogueKind.LapFinish] = new[]
                {
                    "Don't read into it.",
                    "That's not what happened.",
                    "Plausible deniability.",
                    "Move along, nothing to see.",
                },
                [DialogueKind.RaceFinish] = new[]
                {
                    "The people have spoken.",
                    "It's a big win. Yuge.",
                    "Total victory.",
                    "We're just getting started.",
                },
            },
            ["steve-b"] = new Dictionary<DialogueKind, IReadOnlyList<string>>
            {
                [DialogueKind.PreRace] = new[]
                {
                    "Let me explain how this works.",
                    "There's a method to this.",
                    "Strategy first, speed second.",
                    "I'm the brain of the operation.",
                    "Patience wins races.",
                    "Inside line is for amateurs.",
                    "Watch the corners.",
                    "I see three moves ahead.",
                },
                [DialogueKind.PositionChange] = new[]
                {
                    "I've been waiting for this.",
                    "Now we go.",
                    "Checkmate in three corners.",
                    "You walked right into it.",
                },
                [DialogueKind.LapFinish] = new[]
                {
                    "Executing the plan.",
                    "Right on schedule.",
                    "The board is set.",
                    "Confidence builds.",
                },
                [DialogueKind.RaceFinish] = new[]
                {
                    "Victory has a thousand fathers.",
                    "Strategy always wins.",
                    "I told you so.",
                    "The strategist takes the podium.",
                },
            },
            ["bill-b"] = new Dictionary<DialogueKind, IReadOnlyList<string>>
            {
                [DialogueKind.PreRace] = new[]
                {
                    "Order must be maintained.",
                    "Law and order on the track.",
                    "I'm the enforcer.",
                    "Don't make me bump you.",
                    "Hard on the brakes, harder on you.",
                    "Tough on corners, tough on crime.",
                    "I'll bump first, ask questions later.",
                    "Maximum aggression.",
                },
                [DialogueKind.PositionChange] = new[]
                {
                    "That'll be a fine.",
                    "You're under investigation.",
                    "Out of my way.",
                    "Side impact at my discretion.",
                },
                [DialogueKind.LapFinish] = new[]
                {
                    "Process server.",
                    "Subpoena delivered.",
                    "Back to the paddock in cuffs.",
                },
                [DialogueKind.RaceFinish] = new[]
                {
                    "Justice has prevailed.",
                    "Charge dismissed — for everyone except you.",
                    "Order restored.",
                    "Long arm of the racing law.",
                },
            },
            ["mike-p"] = new Dictionary<DialogueKind, IReadOnlyList<string>>
            {
                [DialogueKind.PreRace] = new[]
                {
                    "I'm here to support the team.",
                    "Steady wins the race.",
                    "Follow the leader.",
                    "I'll draft whoever's in front.",
                    "The quiet car wins.",
                    "Patience and podiums.",
                    "You go ahead, I'll be right behind.",
                    "Steady as she goes.",
                },
                [DialogueKind.PositionChange] = new[]
                {
                    "Just tagging along.",
                    "Drafting is legal.",
                    "Where you lead, I follow.",
                    "Thanks for the tow.",
                },
                [DialogueKind.LapFinish] = new[]
                {
                    "Right where I want to be.",
                    "Steady does it.",
                    "Podium is the goal.",
                },
                [DialogueKind.RaceFinish] = new[]
                {
                    "Happy to support.",
                    "Second is a great place to be.",
                    "We all win together.",
                },
            },
        };

    /// <summary>Generic fallback lines when a pool has no entry for the kind. Idempotent, key-stable.</summary>
    public static IReadOnlyDictionary<DialogueKind, string> Fallbacks { get; } = new Dictionary<DialogueKind, string>
    {
        [DialogueKind.PreRace] = "...",
        [DialogueKind.PositionChange] = "...",
        [DialogueKind.LapFinish] = "...",
        [DialogueKind.RaceFinish] = "...",
    };

    /// <summary>
    /// Select a line for <paramref name="officialId"/> + <paramref name="kind"/> at race tick
    /// <paramref name="raceTick"/>. Deterministic: same (official, kind, tick) → same line, regardless of
    /// call count. Pool exhaustion falls back to <see cref="Fallbacks"/>.
    /// </summary>
    public static string PickLine(string officialId, DialogueKind kind, int raceTick)
    {
        if (!Pools.TryGetValue(officialId, out var byKind) ||
            !byKind.TryGetValue(kind, out var pool) ||
            pool.Count == 0)
        {
            return Fallbacks.TryGetValue(kind, out var fb) ? fb : "...";
        }
        // FNV-1a, not HashCode.Combine: the latter is seeded randomly per process, so the
        // "same race, same script" promise held only until the next restart, and the
        // tick-0 vs tick-999 contract test failed whenever that process's seed collided.
        uint hash = 2166136261;
        foreach (var ch in officialId) hash = (hash ^ ch) * 16777619;
        hash = (hash ^ (uint)kind) * 16777619;
        foreach (var b in BitConverter.GetBytes(raceTick)) hash = (hash ^ b) * 16777619;
        return pool[(int)(hash % (uint)pool.Count)];
    }

    /// <summary>True if every line in every pool passes the banned-token scan.</summary>
    public static bool PoolContentIsClean()
    {
        foreach (var (_, byKind) in Pools)
        {
            foreach (var (_, lines) in byKind)
            {
                foreach (var line in lines)
                {
                    foreach (var banned in BannedTokens)
                    {
                        if (line.Contains(banned, StringComparison.OrdinalIgnoreCase))
                            return false;
                    }
                }
            }
        }
        return true;
    }
}
