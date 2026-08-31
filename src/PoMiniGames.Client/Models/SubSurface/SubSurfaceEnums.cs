namespace PoMiniGamesClient.Models.SubSurface;

public enum SubSurfaceMaterial : byte
{
    Air = 0,
    CohesiveSand = 1,
    Concrete = 2,
    Water = 3,
    Bedrock = 4
}

public enum SubSurfaceTool : byte
{
    DigVacuum = 0,
    Sand = 1,
    Concrete = 2,
    Water = 3,
    TNTBomb = 4,
    WaterBalloon = 5
}

public enum SubSurfacePreset
{
    DefaultHorizon,
    DeepCaverns,
    SlingshotDemolition
}
