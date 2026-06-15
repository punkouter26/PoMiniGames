namespace PoShared.Games;

public sealed class PoRacerScoreDto
{
    public string PlayerDisplayName { get; set; } = "";
    public double TotalTimeSeconds { get; set; }
    public int FinalPosition { get; set; }
    public DateTimeOffset AchievedAtUtc { get; set; }
    public bool IsGuest { get; set; }
}

public sealed record PoRacerLobbyPlayer(
    string ConnectionId,
    string DisplayName,
    bool IsGuest,
    bool IsReady);

public sealed record PoRacerLobbyState(
    IReadOnlyList<PoRacerLobbyPlayer> Players,
    string? HostConnectionId,
    DateTimeOffset LastUpdatedUtc);
