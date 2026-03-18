namespace PoMiniGames.Features.PoRaceRagdoll;

public interface IRacerService
{
    IReadOnlyList<RacerSpecies> GetAvailableSpecies();
    IReadOnlyList<Racer> GenerateRacers();
}

public sealed class RacerService : IRacerService
{
    private readonly IOddsService _oddsService;

    public RacerService(IOddsService oddsService) => _oddsService = oddsService;

    public IReadOnlyList<RacerSpecies> GetAvailableSpecies() => RacerData.AvailableSpecies;

    public IReadOnlyList<Racer> GenerateRacers()
    {
        var racers = new List<Racer>();

        for (var i = 0; i < 8; i++)
        {
            var species = RacerData.AvailableSpecies[Random.Shared.Next(RacerData.AvailableSpecies.Count)];
            var massVariance = (Random.Shared.NextDouble() * 10) - 5;
            var finalMass = Math.Max(10, species.Mass + massVariance);
            var odds = _oddsService.CalculateOdds(finalMass, GameConfig.SlopeAngle);

            racers.Add(new Racer(
                Id: i,
                Name: BuildRacerName(species, i + 1),
                Species: species.Name,
                Type: species.Type,
                Color: species.Color,
                Mass: Math.Round(finalMass, 1),
                Odds: odds
            ));
        }

        return racers;
    }

    private static string BuildRacerName(RacerSpecies species, int laneNumber)
    {
        if (!RacerData.NamePools.TryGetValue(species.Type, out var names) || names.Length == 0)
            return $"{species.Name} {laneNumber}";

        var baseName = names[Random.Shared.Next(names.Length)];
        return $"{baseName} the {species.Name} ({laneNumber})";
    }
}

