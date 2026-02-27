namespace PoMiniGames.Features.PoRaceRagdoll;

public record RacerSpecies(
    string Name,
    string Type,
    double Mass,
    string Color,
    string Emoji
);

public record Racer(
    int Id,
    string Name,
    string Species,
    string Type,
    string Color,
    double Mass,
    int Odds
);

public record RaceResult(
    int WinnerId,
    string WinnerName,
    bool PlayerWon,
    int Payout,
    int NewBalance
);

public record GameState(
    int Balance,
    int Round,
    int MaxRounds,
    string State, // BETTING, RACING, FINISHED
    IReadOnlyList<Racer> Racers,
    int? SelectedRacerId,
    int BetAmount,
    int? WinnerId
);

public record PlaceBetRequest(int RacerId);

public record FinishRaceRequest(int WinnerId);
