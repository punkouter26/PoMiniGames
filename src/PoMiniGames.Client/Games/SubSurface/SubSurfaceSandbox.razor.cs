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
    protected SubSurfacePreset SelectedPreset { get; set; } = SubSurfacePreset.DefaultHorizon;

    protected static readonly IReadOnlyList<SubSurfacePreset> Presets =
    [
        SubSurfacePreset.DefaultHorizon,
        SubSurfacePreset.DeepCaverns,
        SubSurfacePreset.SlingshotDemolition
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

    protected async Task OnBrushRadiusChanged(int radius)
    {
        BrushRadius = radius;
        await Interop.SetBrushRadiusAsync(radius);
    }

    protected async Task TogglePause()
    {
        IsPaused = !IsPaused;
        await Interop.SetPausedAsync(IsPaused);
    }

    protected async Task StepOnce()
    {
        await Interop.StepOnceAsync();
    }

    protected async Task OnPresetChanged(object presetObj)
    {
        if (presetObj is SubSurfacePreset preset)
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
