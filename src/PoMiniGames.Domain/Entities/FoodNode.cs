namespace PoMiniGames.Domain.Entities.Simulation;

public sealed class FoodNode
{
    public int SpawnTurn      { get; }
    public int TtlHeartbeats  { get; }

    /// <summary>Returns true once <paramref name="currentTurn"/> - SpawnTurn >= TtlHeartbeats.</summary>
    public bool IsWithered(int currentTurn) => currentTurn - SpawnTurn >= TtlHeartbeats;

    public FoodNode(int spawnTurn, int ttlHeartbeats)
    {
        if (ttlHeartbeats <= 0) throw new ArgumentOutOfRangeException(nameof(ttlHeartbeats));
        SpawnTurn     = spawnTurn;
        TtlHeartbeats = ttlHeartbeats;
    }
}
