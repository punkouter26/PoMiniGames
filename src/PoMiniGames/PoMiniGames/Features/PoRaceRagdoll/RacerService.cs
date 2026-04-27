namespace PoMiniGames.Features.PoRaceRagdoll;

public interface IRacerService
{
    IReadOnlyList<RacerSpecies> GetAvailableSpecies();
    IReadOnlyList<Racer> GenerateRacers();
    int CalculatePayout(int betAmount, int odds, bool playerWon);
}

public sealed class RacerService : IRacerService
{
    public IReadOnlyList<RacerSpecies> GetAvailableSpecies() => RacerData.AvailableSpecies;

    public IReadOnlyList<Racer> GenerateRacers()
    {
        var racers = new List<Racer>();

        for (var i = 0; i < 8; i++)
        {
            var species = RacerData.AvailableSpecies[Random.Shared.Next(RacerData.AvailableSpecies.Count)];
            var massVariance = (Random.Shared.NextDouble() * 10) - 5;
            var finalMass = Math.Max(10, species.Mass + massVariance);
            var odds = CalculateOdds(finalMass, GameConfig.SlopeAngle);

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

    public int CalculatePayout(int betAmount, int odds, bool playerWon)
    {
        if (!playerWon) return 0;

        double profit;
        if (odds > 0)
            profit = betAmount * (odds / 100.0);
        else
            profit = betAmount * (100.0 / Math.Abs(odds));

        return (int)Math.Floor(profit) + betAmount;
    }

    private static int CalculateOdds(double racerMass, double slopeAngle)
    {
        var score = 50.0;
        var massFactor = racerMass * 2;

        if (slopeAngle >= 20)
            score += massFactor * 0.5;
        else
            score += massFactor * 0.2;

        score += (Random.Shared.NextDouble() * 20) - 10;

        var probability = (score + 50) / 200;
        probability = Math.Max(0.05, Math.Min(0.95, probability));

        if (probability >= 0.5)
            return -(int)Math.Round((probability / (1 - probability)) * 100);
        else
            return (int)Math.Round(((1 - probability) / probability) * 100);
    }

    private static string BuildRacerName(RacerSpecies species, int laneNumber)
    {
        if (!RacerData.NamePools.TryGetValue(species.Type, out var names) || names.Length == 0)
            return $"{species.Name} {laneNumber}";

        var baseName = names[Random.Shared.Next(names.Length)];
        return $"{baseName} the {species.Name} ({laneNumber})";
    }
}

