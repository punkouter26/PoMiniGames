namespace PoMiniGames.Client.Games.PoEcosystem.Services;

using Supercluster.KDTree;
using PoMiniGames.Shared.Games.PoEcosystem;

/// <summary>
/// High-performance KD-tree spatial index service for the Blazor client, providing
/// O(log N) nearest-settlement and perimeter encroachment queries.
/// </summary>
public sealed class TribalSpatialIndex
{
    private KDTree<float, int>? _settlementTree;
    private readonly List<TribeStateDto> _tribes = [];

    private static double Metric(float[] a, float[] b) =>
        Math.Sqrt(Math.Pow(a[0] - b[0], 2) + Math.Pow(a[1] - b[1], 2));

    public void UpdateTribes(IReadOnlyList<TribeStateDto> tribes)
    {
        _tribes.Clear();
        _tribes.AddRange(tribes);

        if (tribes.Count == 0)
        {
            _settlementTree = null;
            return;
        }

        var points = new float[tribes.Count][];
        var nodes = new int[tribes.Count];

        for (var i = 0; i < tribes.Count; i++)
        {
            points[i] = [tribes[i].CenterX, tribes[i].CenterZ];
            nodes[i] = tribes[i].Id;
        }

        _settlementTree = new KDTree<float, int>(2, points, nodes, Metric);
    }

    public (int TribeId, float Distance)? FindNearestTribe(float x, float z)
    {
        if (_settlementTree is null || _tribes.Count == 0) return null;

        var nearest = _settlementTree.NearestNeighbors([x, z], 1);
        if (nearest.Length == 0) return null;

        var tuple = nearest[0];
        var dist = (float)Metric([x, z], tuple.Item1);
        return (tuple.Item2, dist);
    }

    public bool IsInTribeTerritory(float x, float z, int tribeId)
    {
        var tribe = _tribes.FirstOrDefault(t => t.Id == tribeId);
        if (tribe is null) return false;

        var dist = MathF.Sqrt(MathF.Pow(x - tribe.CenterX, 2) + MathF.Pow(z - tribe.CenterZ, 2));
        return dist <= tribe.TerritoryRadius;
    }
}
