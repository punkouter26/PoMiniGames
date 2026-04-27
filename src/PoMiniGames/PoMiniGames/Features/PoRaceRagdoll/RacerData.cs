namespace PoMiniGames.Features.PoRaceRagdoll;

/// <summary>Static data tables for racer species and name pools.</summary>
internal static class RacerData
{
    internal static readonly Dictionary<string, string[]> NamePools =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["human"]   = ["Dash", "Blaze", "Ryder", "Skye", "Nova", "Ace", "Milo", "Zara"],
            ["spider"]  = ["Silk", "Fang", "Orbit", "Webber", "Hex", "Thread", "Nox", "Spinner"],
            ["dog"]     = ["Bolt", "Rex", "Scout", "Buddy", "Mochi", "Duke", "Koda", "Piper"],
            ["snake"]   = ["Viper", "Slither", "Cobra", "Jade", "Sly", "Mamba", "Onyx", "Slink"],
            ["crab"]    = ["Clawdia", "Snap", "Shelly", "Pinch", "Coral", "Tide", "Reef", "Crush"],
            ["dino"]    = ["Rexa", "Stomp", "Spike", "Giga", "Cretor", "Roar", "Boulder", "Titan"],
            ["penguin"] = ["Waddle", "Chill", "Pebble", "Frost", "Nippy", "Flipper", "Icy", "Skate"],
            ["alien"]   = ["Zorb", "Quark", "Nebula", "Xeno", "Orion", "Vega", "Cosmo", "Pulse"]
        };

    internal static readonly IReadOnlyList<RacerSpecies> AvailableSpecies =
    [
        new("Human",   "human",   70,  "#FFCCAA", "🏃"),
        new("Spider",  "spider",  40,  "#9932CC", "🕷️"),
        new("Dog",     "dog",     50,  "#CD853F", "🐕"),
        new("Snake",   "snake",   30,  "#32CD32", "🐍"),
        new("Crab",    "crab",    45,  "#FF4500", "🦀"),
        new("Dino",    "dino",    120, "#FF6B6B", "🦖"),
        new("Penguin", "penguin", 35,  "#87CEEB", "🐧"),
        new("Alien",   "alien",   60,  "#00FF00", "👽")
    ];
}
