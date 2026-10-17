using PoMiniGames.Shared.Games.PoEcosystem;

namespace PoMiniGames.Features.PoEcosystem;

/// <summary>
/// The three clans' cultural identity (deity, totem, taboo, war cry), picked per seed from
/// fixed tables. Deterministic and local: the same seed always names the same pantheon.
/// </summary>
public static class EcosystemCulture
{
    private static readonly string[] DeitiesA = ["Sol-Rhea the Dawn Mother", "Ignis of the Sun Peaks", "Aurelius the Light Giver"];
    private static readonly string[] DeitiesB = ["Thalor the Deep Warden", "Maris the Tide Weaver", "Nereus of the Abyssal Current"];
    private static readonly string[] DeitiesC = ["Sylva the Root Binder", "Cernun the Horned Warden", "Vera of the Canopy"];

    public static IReadOnlyList<EcoCultureProfile> ForSeed(int seed)
    {
        var rng = new Random(seed);
        return
        [
            new EcoCultureProfile(1, "Amber Clan", DeitiesA[rng.Next(DeitiesA.Length)], "Golden Sun Eagle", "Never fell a cedar tree at dusk", "By the First Light!"),
            new EcoCultureProfile(2, "Cobalt Clan", DeitiesB[rng.Next(DeitiesB.Length)], "Great Tide Serpent", "Never taint a fresh water spring", "Rise with the Surge!"),
            new EcoCultureProfile(3, "Verdant Clan", DeitiesC[rng.Next(DeitiesC.Length)], "Grand Horned Stag", "Never hunt a nursing doe", "The Roots Hold Firm!"),
        ];
    }
}
