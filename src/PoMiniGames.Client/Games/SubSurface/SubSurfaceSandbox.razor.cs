using Microsoft.AspNetCore.Components;
using PoMiniGamesClient.Models.SubSurface;
using PoMiniGamesClient.Services;

namespace PoMiniGamesClient.Games.SubSurface;

public partial class SubSurfaceSandbox : ComponentBase, IAsyncDisposable
{
    private ElementReference _canvasRef;
    private bool _initialized;
    private SubSurfaceDiagnostics _diagnostics = new(60.0, 2, 0, 0, 0, 0);

    protected SubSurfaceTool SelectedTool { get; set; } = SubSurfaceTool.DigVacuum;
    protected int BrushRadius { get; set; } = 8;
    protected bool IsPaused { get; set; }
    protected bool AutoDrop { get; set; } = true;
    protected SubSurfacePreset SelectedPreset { get; set; } = SubSurfacePreset.DefaultHorizon;

    protected static readonly IReadOnlyList<SubSurfacePreset> Presets =
    [
        SubSurfacePreset.DefaultHorizon,
        SubSurfacePreset.DeepCaverns,
        SubSurfacePreset.SlingshotDemolition
    ];

    protected static readonly IReadOnlyList<(SubSurfaceTool Tool, string Label, string Hint)> ToolButtons =
    [
        (SubSurfaceTool.DigVacuum, "🌪️ Dig Vacuum", "Erases sand and water; preserves concrete"),
        (SubSurfaceTool.Sand, "🏜️ Sand", "Paints cohesive granular soil"),
        (SubSurfaceTool.Concrete, "🧱 Concrete", "Paints rigid reinforced concrete bars"),
        (SubSurfaceTool.Water, "💧 Water", "Paints incompressible fluid"),
        (SubSurfaceTool.TNTBomb, "💣 5s TNT", "Slingshot ordnance: 5s fuse; detonates on land or underwater, ejecting soil and water"),
        (SubSurfaceTool.WaterBalloon, "🎈 Balloon", "Slingshot ordnance: bursts pressurized water on impact")
    ];

    protected override void OnInitialized()
    {
        Interop.OnMetricsReceived += HandleMetricsUpdate;
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender && !_initialized)
        {
            _initialized = true;
            await Interop.InitializeAsync(_canvasRef);
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
        await Interop.DisposeAsync();
    }
}
