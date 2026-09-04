namespace PoMiniGamesClient.Models.SubSurface;

public sealed record SubSurfaceToolConfig(
    SubSurfaceTool Tool,
    int BrushRadius,
    bool IsPaused,
    float SlingshotMultiplier = 1.0f)
{
    public static SubSurfaceToolConfig Default => new(
        Tool: SubSurfaceTool.DigVacuum,
        BrushRadius: 8,
        IsPaused: false);
}

public sealed record SubSurfaceDiagnostics(
    double Fps,
    int SubSteps,
    int ActiveProjectiles,
    int SubmergedTNTCount,
    int ActiveFluidCells,
    int ActiveSandCells,
    int AirborneGrains = 0,
    // Conservation audit: matter that neither the grid census nor a counted
    // lateral drain accounts for, accumulated since load. 0 means the
    // simulation has not lost or invented a cell. Ported in concept from
    // Sand2's ledger — without it, a leaking blast is indistinguishable from
    // ejecta that legitimately drained off the open edges.
    int ResidualSand = 0,
    int ResidualWater = 0);

/// <summary>
/// Engine report for a physics tier change. <see cref="Effective"/> is the tier
/// currently stepping the grid; <see cref="Requested"/> differs while a relink
/// is <see cref="Pending"/> or after one <see cref="Failed"/> (the engine then
/// keeps the effective tier, and the selector follows it).
/// </summary>
public sealed record SubSurfaceRealismStatus(
    SubSurfaceRealism Requested,
    SubSurfaceRealism Effective,
    bool Pending,
    bool Failed,
    int CompileMs,
    string Message);
