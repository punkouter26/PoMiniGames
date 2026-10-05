namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>The four commodities. The value is the index into every goods array.</summary>
public enum Good : byte { Food, Energy, Smithore, Crystite }

public enum Species : byte
{
    Gollumoid, Voltronix, OreGorger, CrystiteWeaver, ZephyrFlapper, BonzCrusher, SpheroidDrifter, Humanoid,
}

/// <summary>Who is driving a seat. <see cref="Human"/> is the player; the rest are AI personalities.</summary>
public enum Archetype : byte { Human, Hoarder, Industrialist, Prospector, Agitator, Farmer, Speculator, Gambler }

/// <summary>One playable species, as the picker shows it.</summary>
public sealed record SpeciesInfo(Species Id, string Name, string Look, int StartingCash, string Trait);

/// <summary>The roster. The rules that apply each trait live next to the rule they bend.</summary>
public static class PoMuleSpecies
{
    public static readonly IReadOnlyList<SpeciesInfo> All =
    [
        new(Species.Gollumoid, "Gollumoid", "Amphibious biped with wide eyes", 1000, "Agriculturalist: +15% Food on river plots"),
        new(Species.Voltronix, "Voltronix", "Segmented robotic chassis", 1000, "Power Core: 1 free Energy every month"),
        new(Species.OreGorger, "Ore-Gorger", "Dense, rocky quad-arm brute", 1000, "Excavator: no mountain slowdown, +15% Smithore"),
        new(Species.CrystiteWeaver, "Crystite-Weaver", "Crystalline ethereal being", 800, "Prospector: sees Crystite without an assay"),
        new(Species.ZephyrFlapper, "Zephyr-Flapper", "Feathered, winged scout", 1600, "High Roller: more cash, +10% speed"),
        new(Species.BonzCrusher, "Bonz-Crusher", "Armored reptilian wanderer", 1000, "Heavyweight: cannot be pushed, shoves others aside"),
        new(Species.SpheroidDrifter, "Spheroid-Drifter", "Hovering orb with manipulator arms", 1000, "Stabilizer: ignores terrain, M.U.L.E.s bolt half as often"),
        new(Species.Humanoid, "Humanoid Settler", "Traditional terran astronaut", 1200, "Jack-of-all-Trades: no bonuses, no penalties"),
    ];

    public static SpeciesInfo Get(Species species) => All[(int)species];
}
