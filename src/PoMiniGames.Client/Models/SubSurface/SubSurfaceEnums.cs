namespace PoMiniGamesClient.Models.SubSurface;

// Material ids mirror the JS/GLSL MAT_* constants in
// wwwroot/js/subsurface/subsurface-physics.glsl.js — change both together.
public enum SubSurfaceMaterial : byte
{
    Air = 0,
    CohesiveSand = 1,
    Concrete = 2,
    Water = 3,
    Bedrock = 4,
    Debris = 5,
    Lava = 6,
    Oil = 7,
    Fire = 8,
    Obsidian = 9
}

// Tool ids are the JS engine's currentTool values. Brush tools (0-3, 6, 7)
// deliberately share their material's id; 4/5 and 8-11 are slingshot ordnance.
public enum SubSurfaceTool : byte
{
    DigVacuum = 0,
    Sand = 1,
    Concrete = 2,
    Water = 3,
    TNTBomb = 4,
    WaterBalloon = 5,
    Lava = 6,
    Oil = 7,
    DrillBomb = 8,
    ClusterBomb = 9,
    Nuke = 10,
    StickyBomb = 11
}

public enum SubSurfacePreset
{
    DefaultHorizon,
    DeepCaverns,
    SlingshotDemolition
}
