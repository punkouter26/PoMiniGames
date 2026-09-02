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
    int AirborneGrains = 0);

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
