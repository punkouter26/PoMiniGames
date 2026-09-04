using Microsoft.AspNetCore.Components;
using PoMiniGamesClient.Models.SubSurface;
using PoMiniGamesClient.Services;

namespace PoMiniGamesClient.Games.SubSurface;

public partial class SubSurfaceSandbox : ComponentBase, IAsyncDisposable
{
    private ElementReference _canvasRef;
    private bool _initialized;
    private SubSurfaceDiagnostics _diagnostics = new(60.0, 2, 0, 0, 0, 0);

    /// <summary>
    /// True while the matter ledger is not moving much. Deliberately NOT named
    /// "clean": the shader drains loose matter off the open edge columns
    /// itself, so a settling world drifts for entirely legitimate reasons and a
    /// non-zero reading is not by itself a defect. The threshold is generous
    /// because the census is sampled every few frames — a grain mid-landing is
    /// briefly on neither side of the books.
    /// </summary>
    private bool LedgerSteady =>
        Math.Abs(_diagnostics.ResidualSand) <= 64 && Math.Abs(_diagnostics.ResidualWater) <= 64;
    private SubSurfaceRealismStatus _realism = new(SubSurfaceRealism.Medium, SubSurfaceRealism.None, true, false, 0, "");

    /// <summary>
    /// Demo (kiosk/attract) mode: ordnance rains from the sky automatically.
    /// 1-player starts with auto-drop off so the player aims every shot; the
    /// toolbar toggle can still turn the rain on in either mode.
    /// </summary>
    [Parameter] public bool IsDemo { get; set; }

    protected SubSurfaceTool SelectedTool { get; set; } = SubSurfaceTool.DigVacuum;
    protected int BrushRadius { get; set; } = 8;
    protected bool IsPaused { get; set; }
    protected bool AutoDrop { get; set; }
    protected bool SoundOn { get; set; } = true;
    protected SubSurfacePreset SelectedPreset { get; set; } = SubSurfacePreset.DefaultHorizon;

    /// <summary>
    /// Medium by default — deliberately still Medium, after an attempt to make
    /// it High was measured and backed out.
    ///
    /// High is where the water physics this game is built around actually
    /// lives: hydrostatic rise and communicating vessels, erosion, suspended
    /// sediment, infiltration, mud creep and fast fall are all
    /// `#if REALISM >= 3`. So shipping Medium means shipping that switched off,
    /// and it is worth wanting to fix.
    ///
    /// It cannot be fixed from here, though. Measured under software GL: the
    /// High chain never reports completion at all — still "compiling" after
    /// 150 s, with the simulation pinned at 1 FPS the whole time because the
    /// driver starves the frame loop. Capping that wait then cancels Medium
    /// too, which links but is also slow, leaving the page on Low: worse
    /// again. Every lever available at this layer trades one regression for
    /// another.
    ///
    /// The actual fix is to stop asking one enormous branchy shader to link at
    /// all — split the physics into several small specialised passes, the way
    /// the sibling Sand2 engine does. Until then Medium is the honest default.
    ///
    /// The engine bootstraps on Low and chases this tier in the background; a
    /// failed upgrade now steps DOWN a tier rather than pinning to whatever is
    /// linked, and a link still running after two minutes is abandoned.
    /// </summary>
    protected SubSurfaceRealism SelectedRealism { get; set; } = SubSurfaceRealism.Medium;

    protected static readonly IReadOnlyList<SubSurfaceRealism> RealismLevels =
    [
        SubSurfaceRealism.Low,
        SubSurfaceRealism.Medium,
        SubSurfaceRealism.High
    ];

    protected static readonly IReadOnlyList<SubSurfacePreset> Presets =
    [
        SubSurfacePreset.DefaultHorizon,
        SubSurfacePreset.DeepCaverns,
        SubSurfacePreset.SlingshotDemolition
    ];

    protected static readonly IReadOnlyList<(SubSurfaceTool Tool, string Label, string Hint)> MaterialButtons =
    [
        (SubSurfaceTool.DigVacuum, "🌪️ Dig", "Erases sand, liquids, fire, and obsidian; preserves concrete"),
        (SubSurfaceTool.Sand, "🏜️ Sand", "Paints cohesive granular soil"),
        (SubSurfaceTool.Concrete, "🧱 Concrete", "Paints rigid reinforced concrete bars"),
        (SubSurfaceTool.Water, "💧 Water", "Paints incompressible fluid"),
        (SubSurfaceTool.Lava, "🌋 Lava", "Paints viscous molten rock: melts sand, ignites oil, quenches to obsidian in water"),
        (SubSurfaceTool.Oil, "🛢️ Oil", "Paints flammable crude that floats on water and burns on contact with lava or fire")
    ];

    protected static readonly IReadOnlyList<(SubSurfaceTool Tool, string Label, string Hint)> OrdnanceButtons =
    [
        (SubSurfaceTool.TNTBomb, "💣 TNT", "5s fuse; detonates on land or underwater, ejecting soil and water"),
        (SubSurfaceTool.WaterBalloon, "🎈 Balloon", "Bursts pressurized water on impact"),
        (SubSurfaceTool.DrillBomb, "🗜️ Drill", "Bunker-buster: bores through soil and concrete, then detonates at depth"),
        (SubSurfaceTool.ClusterBomb, "🧨 Cluster", "Pops on impact into a fan of live bomblets"),
        (SubSurfaceTool.Nuke, "☢️ Nuke", "Massive-yield blast with a vitrified crater; use sparingly"),
        (SubSurfaceTool.StickyBomb, "🟢 Sticky", "Adheres to the first surface it touches, then detonates on a 4s fuse")
    ];

    protected override void OnInitialized()
    {
        Interop.OnMetricsReceived += HandleMetricsUpdate;
        Interop.OnRealismStatusReceived += HandleRealismStatus;
        AutoDrop = IsDemo;
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender && !_initialized)
        {
            _initialized = true;
            await Interop.InitializeAsync(_canvasRef, SelectedRealism);
            await Interop.SetToolAsync(SelectedTool);
            await Interop.SetBrushRadiusAsync(BrushRadius);
            await Interop.SetAutoDropAsync(AutoDrop);
        }
    }

    private void HandleMetricsUpdate(SubSurfaceDiagnostics diagnostics)
    {
        _diagnostics = diagnostics;
        InvokeAsync(StateHasChanged);
    }

    private void HandleRealismStatus(SubSurfaceRealismStatus status)
    {
        _realism = status;
        if (status.Failed && status.Effective != SubSurfaceRealism.None)
        {
            SelectedRealism = status.Effective;
        }
        InvokeAsync(StateHasChanged);
    }

    protected async Task OnRealismChanged(ChangeEventArgs args)
    {
        if (Enum.TryParse<SubSurfaceRealism>(args.Value?.ToString(), out var realism) &&
            realism != SubSurfaceRealism.None)
        {
            SelectedRealism = realism;
            await Interop.SetRealismAsync(realism);
        }
    }

    protected async Task OnToolChanged(SubSurfaceTool tool)
    {
        SelectedTool = tool;
        await Interop.SetToolAsync(tool);
    }

    protected async Task OnBrushRadiusInput(ChangeEventArgs args)
    {
        if (int.TryParse(args.Value?.ToString(), out var radius))
        {
            BrushRadius = Math.Clamp(radius, 1, 32);
            await Interop.SetBrushRadiusAsync(BrushRadius);
        }
    }

    protected async Task TogglePause()
    {
        IsPaused = !IsPaused;
        await Interop.SetPausedAsync(IsPaused);
    }

    protected async Task ToggleAutoDrop()
    {
        AutoDrop = !AutoDrop;
        await Interop.SetAutoDropAsync(AutoDrop);
    }

    protected async Task ToggleSound()
    {
        SoundOn = !SoundOn;
        await Interop.SetAudioEnabledAsync(SoundOn);
    }

    protected async Task StepOnce()
    {
        await Interop.StepOnceAsync();
    }

    protected async Task OnPresetChanged(ChangeEventArgs args)
    {
        if (Enum.TryParse<SubSurfacePreset>(args.Value?.ToString(), out var preset))
        {
            SelectedPreset = preset;
            await Interop.LoadPresetAsync(preset);
        }
    }

    protected async Task ResetScene()
    {
        await Interop.ResetAsync();
    }

    public async ValueTask DisposeAsync()
    {
        Interop.OnMetricsReceived -= HandleMetricsUpdate;
        Interop.OnRealismStatusReceived -= HandleRealismStatus;
        await Interop.DisposeAsync();
    }
}
