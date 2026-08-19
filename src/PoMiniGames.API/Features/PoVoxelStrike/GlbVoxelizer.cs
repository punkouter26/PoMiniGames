using System.Numerics;
using SharpGLTF.Schema2;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// GLB triangle mesh → palette-indexed voxel volume. Fixed detail: the model's longest
/// axis becomes <see cref="PoVoxelStrikeOptions.VoxelResolution"/> voxels.
///
/// v1 deliberately samples material <b>base-color factors</b> only — texture sampling
/// needs an image decoder and is a post-v1 milestone (PRD §7). Surface voxels are marked
/// by barycentric sampling at half-voxel pitch (robust for arbitrary triangle soups
/// without a SAT triangle/box test); the interior is closed by an outside flood fill so
/// carved structures read as solid mass, not shells.
/// </summary>
public static class GlbVoxelizer
{
    // One default material until per-file overrides ship: roughly "concrete-ish" so the
    // M2 stress solver has plausible constants to start from.
    private static readonly PvxMaterial DefaultMaterial = new(
        Density: 600f, CompressiveStrength: 5_000_000f, TensileStrength: 2_000_000f);

    public static PvxVolume Voxelize(string glbPath, int resolution)
    {
        var model = ModelRoot.Load(glbPath);
        var triangles = CollectTriangles(model);
        if (triangles.Count == 0)
        {
            throw new InvalidDataException("GLB contains no triangle geometry.");
        }
        return Voxelize(triangles, resolution);
    }

    internal readonly record struct Triangle(Vector3 A, Vector3 B, Vector3 C, Vector4 Color);

    private static List<Triangle> CollectTriangles(ModelRoot model)
    {
        var triangles = new List<Triangle>();
        var scene = model.DefaultScene;
        if (scene is null)
        {
            return triangles;
        }

        foreach (var node in scene.VisualChildren)
        {
            Visit(node);
        }
        return triangles;

        void Visit(Node node)
        {
            if (node.Mesh is not null)
            {
                var world = node.WorldMatrix;
                foreach (var primitive in node.Mesh.Primitives)
                {
                    var positions = primitive.GetVertexAccessor("POSITION")?.AsVector3Array();
                    if (positions is null)
                    {
                        continue;
                    }
                    var color = BaseColorOf(primitive.Material);
                    foreach (var (ia, ib, ic) in primitive.GetTriangleIndices())
                    {
                        triangles.Add(new Triangle(
                            Vector3.Transform(positions[ia], world),
                            Vector3.Transform(positions[ib], world),
                            Vector3.Transform(positions[ic], world),
                            color));
                    }
                }
            }
            foreach (var child in node.VisualChildren)
            {
                Visit(child);
            }
        }
    }

    private static Vector4 BaseColorOf(Material? material)
    {
        var channel = material?.FindChannel("BaseColor");
        return channel?.Color ?? new Vector4(0.72f, 0.72f, 0.75f, 1f);
    }

    internal static PvxVolume Voxelize(IReadOnlyList<Triangle> triangles, int resolution)
    {
        var min = new Vector3(float.MaxValue);
        var max = new Vector3(float.MinValue);
        foreach (var t in triangles)
        {
            min = Vector3.Min(min, Vector3.Min(t.A, Vector3.Min(t.B, t.C)));
            max = Vector3.Max(max, Vector3.Max(t.A, Vector3.Max(t.B, t.C)));
        }

        var extent = max - min;
        var maxExtent = MathF.Max(extent.X, MathF.Max(extent.Y, extent.Z));
        if (maxExtent <= 0f)
        {
            throw new InvalidDataException("GLB geometry has zero extent.");
        }
        var voxelSize = maxExtent / resolution;

        var nx = Math.Clamp((int)MathF.Ceiling(extent.X / voxelSize), 1, resolution);
        var ny = Math.Clamp((int)MathF.Ceiling(extent.Y / voxelSize), 1, resolution);
        var nz = Math.Clamp((int)MathF.Ceiling(extent.Z / voxelSize), 1, resolution);

        var cells = new byte[nx * ny * nz];
        var palette = new PaletteBuilder();

        foreach (var t in triangles)
        {
            var index = palette.IndexOf(t.Color);
            MarkTriangle(t, index);
        }

        FillInterior(cells, nx, ny, nz, palette);

        return new PvxVolume
        {
            DimX = nx,
            DimY = ny,
            DimZ = nz,
            Palette = palette.Entries,
            Materials = [DefaultMaterial],
            Cells = cells,
        };

        void MarkTriangle(in Triangle t, byte paletteIndex)
        {
            // Sample pitch of half a voxel guarantees no voxel the triangle crosses is
            // skipped; the step count is capped so one degenerate giant triangle cannot
            // stall ingestion (its voxel coverage is bounded by the grid anyway).
            var maxEdge = MathF.Max((t.B - t.A).Length(), MathF.Max((t.C - t.B).Length(), (t.A - t.C).Length()));
            var steps = Math.Clamp((int)MathF.Ceiling(maxEdge / (voxelSize * 0.5f)), 1, 2 * resolution);
            for (var i = 0; i <= steps; i++)
            {
                for (var j = 0; j <= steps - i; j++)
                {
                    var p = t.A + (t.B - t.A) * (i / (float)steps) + (t.C - t.A) * (j / (float)steps);
                    var v = (p - min) / voxelSize;
                    var x = Math.Clamp((int)v.X, 0, nx - 1);
                    var y = Math.Clamp((int)v.Y, 0, ny - 1);
                    var z = Math.Clamp((int)v.Z, 0, nz - 1);
                    cells[x + y * nx + z * nx * ny] = paletteIndex;
                }
            }
        }
    }

    /// <summary>
    /// Empty cells with no 6-connected path to the grid boundary are enclosed by the
    /// surface shell — fill them so the volume is solid mass. Filled with the average
    /// surface color so a carve reveals plausible "core" rather than a void color.
    /// </summary>
    private static void FillInterior(byte[] cells, int nx, int ny, int nz, PaletteBuilder palette)
    {
        var outside = new bool[cells.Length];
        var queue = new Queue<(int X, int Y, int Z)>();

        for (var z = 0; z < nz; z++)
        {
            for (var y = 0; y < ny; y++)
            {
                for (var x = 0; x < nx; x++)
                {
                    if ((x == 0 || y == 0 || z == 0 || x == nx - 1 || y == ny - 1 || z == nz - 1)
                        && cells[x + y * nx + z * nx * ny] == 0)
                    {
                        var i = x + y * nx + z * nx * ny;
                        if (!outside[i])
                        {
                            outside[i] = true;
                            queue.Enqueue((x, y, z));
                        }
                    }
                }
            }
        }

        Span<(int Dx, int Dy, int Dz)> dirs = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)];
        while (queue.Count > 0)
        {
            var (x, y, z) = queue.Dequeue();
            foreach (var (dx, dy, dz) in dirs)
            {
                int qx = x + dx, qy = y + dy, qz = z + dz;
                if (qx < 0 || qy < 0 || qz < 0 || qx >= nx || qy >= ny || qz >= nz)
                {
                    continue;
                }
                var i = qx + qy * nx + qz * nx * ny;
                if (!outside[i] && cells[i] == 0)
                {
                    outside[i] = true;
                    queue.Enqueue((qx, qy, qz));
                }
            }
        }

        var coreIndex = palette.IndexOf(palette.AverageColor());
        for (var i = 0; i < cells.Length; i++)
        {
            if (cells[i] == 0 && !outside[i])
            {
                cells[i] = coreIndex;
            }
        }
    }

    /// <summary>
    /// Maps RGBA colors to 1-based palette indices, capped at 255 entries (0 = empty on
    /// the wire). Base-color factors keep the palette naturally tiny; on overflow the
    /// nearest existing entry is reused rather than failing the asset.
    /// </summary>
    private sealed class PaletteBuilder
    {
        private readonly List<PvxPaletteEntry> _entries = [];
        private readonly Dictionary<uint, byte> _lookup = [];

        public IReadOnlyList<PvxPaletteEntry> Entries => _entries;

        public byte IndexOf(Vector4 color)
        {
            var r = ToByte(color.X);
            var g = ToByte(color.Y);
            var b = ToByte(color.Z);
            var a = ToByte(color.W);
            var key = (uint)(r << 24 | g << 16 | b << 8 | a);
            if (_lookup.TryGetValue(key, out var existing))
            {
                return existing;
            }
            if (_entries.Count >= 255)
            {
                return Nearest(r, g, b);
            }
            _entries.Add(new PvxPaletteEntry(r, g, b, a, MaterialId: 0));
            var index = (byte)_entries.Count; // 1-based
            _lookup[key] = index;
            return index;
        }

        public Vector4 AverageColor()
        {
            if (_entries.Count == 0)
            {
                return new Vector4(0.6f, 0.6f, 0.62f, 1f);
            }
            float r = 0, g = 0, b = 0;
            foreach (var e in _entries)
            {
                r += e.R; g += e.G; b += e.B;
            }
            var n = _entries.Count * 255f;
            // Darkened: exposed core should read as a cut, not as more painted surface.
            return new Vector4(0.8f * r / n, 0.8f * g / n, 0.8f * b / n, 1f);
        }

        private byte Nearest(byte r, byte g, byte b)
        {
            var best = 1;
            var bestDist = int.MaxValue;
            for (var i = 0; i < _entries.Count; i++)
            {
                var e = _entries[i];
                var dist = (e.R - r) * (e.R - r) + (e.G - g) * (e.G - g) + (e.B - b) * (e.B - b);
                if (dist < bestDist)
                {
                    bestDist = dist;
                    best = i + 1;
                }
            }
            return (byte)best;
        }

        private static byte ToByte(float channel) => (byte)Math.Clamp((int)(channel * 255f + 0.5f), 0, 255);
    }
}
