namespace PoMiniGames.Features.PoRaceRagdoll;

[System.Text.Json.Serialization.JsonConverter(typeof(System.Text.Json.Serialization.JsonStringEnumConverter))]
public enum GamePhase { Betting, Racing, Finished }

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
    GamePhase State,
    IReadOnlyList<Racer> Racers,
    int? SelectedRacerId,
    int BetAmount,
    int? WinnerId
);

public record PlaceBetRequest(int RacerId);

public record FinishRaceRequest(int WinnerId);

