using System.Collections.Concurrent;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>One converted asset the API can serve. Identity is the SHA-256 of the source GLB bytes.</summary>
public sealed record VoxelAssetInfo(
    string Hash,
    string Name,
    int DimX,
    int DimY,
    int DimZ,
    long SizeBytes,
    string PayloadPath);

/// <summary>
/// In-memory index of converted voxel assets. Filled by <see cref="AssetIngestionHostedService"/>
/// (pre-existing .pvx files first, then fresh conversions as each completes) and read by the
/// manifest/payload endpoints — so requests never touch the filesystem for discovery, and a
/// client polling while ingestion is still running simply sees the catalog grow.
/// </summary>
public sealed class VoxelAssetCatalog
{
    private readonly ConcurrentDictionary<string, VoxelAssetInfo> _assets = new(StringComparer.Ordinal);

    public void Add(VoxelAssetInfo asset) => _assets[asset.Hash] = asset;

    public bool TryGet(string hash, out VoxelAssetInfo asset)
    {
        var found = _assets.TryGetValue(hash, out var value);
        asset = value!;
        return found;
    }

    public IReadOnlyList<VoxelAssetInfo> All =>
        _assets.Values.OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase).ToList();
}
