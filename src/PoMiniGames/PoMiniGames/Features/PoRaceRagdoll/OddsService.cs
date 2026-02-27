namespace PoMiniGames.Features.PoRaceRagdoll;

public interface IOddsService
{
    int CalculateOdds(double racerMass, double slopeAngle);
    int CalculatePayout(int betAmount, int odds, bool playerWon);
}

public sealed class OddsService : IOddsService
{
    private readonly Random _random = new();

    public int CalculateOdds(double racerMass, double slopeAngle)
    {
        var score = 50.0;
        var massFactor = racerMass * 2;

        if (slopeAngle > 20)
            score += massFactor * 0.5;
        else
            score += massFactor * 0.2;

        score += (_random.NextDouble() * 20) - 10;

        var probability = (score + 50) / 200;
        probability = Math.Max(0.05, Math.Min(0.95, probability));

        if (probability >= 0.5)
            return -(int)Math.Round((probability / (1 - probability)) * 100);
        else
            return (int)Math.Round(((1 - probability) / probability) * 100);
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
}
