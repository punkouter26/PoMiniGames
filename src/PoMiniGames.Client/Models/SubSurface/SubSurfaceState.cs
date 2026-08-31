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
    int ActiveSandCells);
