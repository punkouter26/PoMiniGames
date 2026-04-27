using System.Collections.Concurrent;

namespace PoMiniGames.Features.PoRunner;

public enum GameStatus
{
    Waiting,
    ReadyCheck,
    Countdown,
    Playing,
    GameOver
}

public enum PlayerAction
{
    Idle,
    Walk
}

public enum PlayerColor
{
    None,
    Yellow,
    Blue,
    Red,
    Green,
    Purple,
    Orange,
    Pink,
    Teal
}

public record ClientState(
    float X,
    float Y,
    string Direction,
    PlayerAction Action,
    int CurrentFrame
);

public class PlayerState
{
    public required string Id { get; init; }
    public float X { get; set; }
    public float Y { get; set; }
    public string Direction { get; set; } = "east";
    public PlayerAction Action { get; set; } = PlayerAction.Idle;
    public int CurrentFrame { get; set; }
    public PlayerColor ColorTint { get; set; } = PlayerColor.None;
    public bool IsReady { get; set; } = false;
}

public class GameRoom
{
    public required string RoomId { get; init; }
    public ConcurrentDictionary<string, PlayerState> Players { get; } = new();
    public GameStatus Status { get; set; } = GameStatus.Waiting;
    public long CountdownStartTimeMs { get; set; } = 0;
    public long RaceStartTimeMs { get; set; } = 0;
    public string FinishedPlayerId { get; set; } = "";
    public long FinishTimeMs { get; set; } = 0;
    public bool HighScoreSubmitted { get; set; } = false;

    [System.Text.Json.Serialization.JsonIgnore]
    public object FinishLock { get; } = new();
}