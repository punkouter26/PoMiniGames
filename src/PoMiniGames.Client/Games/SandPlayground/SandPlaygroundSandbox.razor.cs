using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace PoMiniGamesClient.Games.SandPlayground;

/// <summary>
/// State container and JS-module lifecycle owner for SandPlayground.
/// Blazor owns the docked toolbar; all high-frequency input and the 60 FPS
/// simulation loop live in wwwroot/js/sand-playground/sand-playground-engine.js.
/// </summary>
public partial class SandPlaygroundSandbox : ComponentBase, IAsyncDisposable
{
    [Inject] private IJSRuntime JS { get; set; } = default!;

    private ElementReference _canvas;
    private ElementReference _overlay;
    private IJSObjectReference? _module;

    /// <summary>
    /// Demo (kiosk/attract) mode: ordnance rains from the sky on its own so a
    /// passer-by sees the physics without touching anything. 1-player starts
    /// with auto-drop off — the player aims every shot — but the toolbar toggle
    /// still turns the rain on or off in either mode.
    /// </summary>
    [Parameter] public bool IsDemo { get; set; }

    protected string ActiveTool { get; private set; } = "dig";
    protected int BrushSize { get; private set; } = 8;
    protected bool Paused { get; private set; }
    protected bool DemoOn { get; private set; }
    protected bool AudioOn { get; private set; } = true;
    protected int Volume { get; private set; } = 70;

    protected sealed record ToolDef(string Id, string Label, string Hint);

    protected static readonly ToolDef[] ToolDefs =
    [
        new("dig", "Dig Vacuum", "Drag to extract sand and water (concrete is immune)"),
        new("sand", "Sand", "Drag to pour cohesive sand"),
        new("concrete", "Concrete Bar", "Drag to place a rigid concrete bar — thickness follows the brush slider"),
        new("water", "Water", "Drag to pour water"),
        new("tnt", "TNT (5s)", "Click-drag in open air to slingshot a fused TNT bomb"),
        new("balloon", "Water Balloon", "Click-drag in open air to slingshot an impact water balloon"),
    ];

    protected string ActiveHint =>
        Array.Find(ToolDefs, t => t.Id == ActiveTool)?.Hint ?? string.Empty;

    protected override void OnInitialized() => DemoOn = IsDemo;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!firstRender) return;

        _module = await JS.InvokeAsync<IJSObjectReference>("import", "./js/sand-playground/sand-playground-engine.js");
        await _module.InvokeVoidAsync("init", _canvas, _overlay);
        await _module.InvokeVoidAsync("setTool", ActiveTool);
        await _module.InvokeVoidAsync("setBrush", BrushSize);
        await _module.InvokeVoidAsync("setDemo", DemoOn);
        await _module.InvokeVoidAsync("setAudio", AudioOn, Volume);
    }

    protected async Task ToggleAudioAsync()
    {
        AudioOn = !AudioOn;
        if (_module is not null) await _module.InvokeVoidAsync("setAudio", AudioOn, Volume);
    }

    protected async Task OnVolumeChangedAsync(ChangeEventArgs e)
    {
        if (int.TryParse(e.Value?.ToString(), out var v))
        {
            Volume = Math.Clamp(v, 0, 100);
            if (_module is not null) await _module.InvokeVoidAsync("setAudio", AudioOn, Volume);
        }
    }

    protected async Task SelectToolAsync(string tool)
    {
        ActiveTool = tool;
        if (_module is not null) await _module.InvokeVoidAsync("setTool", tool);
    }

    protected async Task OnBrushChangedAsync(ChangeEventArgs e)
    {
        if (int.TryParse(e.Value?.ToString(), out var v))
        {
            BrushSize = Math.Clamp(v, 1, 32);
            if (_module is not null) await _module.InvokeVoidAsync("setBrush", BrushSize);
        }
    }

    protected async Task TogglePauseAsync()
    {
        Paused = !Paused;
        if (_module is not null) await _module.InvokeVoidAsync("setPaused", Paused);
    }

    protected async Task StepAsync()
    {
        if (_module is not null) await _module.InvokeVoidAsync("stepOnce");
    }

    protected async Task ToggleDemoAsync()
    {
        DemoOn = !DemoOn;
        if (_module is not null) await _module.InvokeVoidAsync("setDemo", DemoOn);
    }

    protected async Task ResetAsync()
    {
        if (_module is not null) await _module.InvokeVoidAsync("reset");
    }

    public async ValueTask DisposeAsync()
    {
        if (_module is not null)
        {
            try
            {
                // dispose() cancels the rAF loop and closes the AudioContext. Without
                // it the simulation keeps running (and sounding) after navigation away.
                await _module.InvokeVoidAsync("dispose");
                await _module.DisposeAsync();
            }
            catch (JSDisconnectedException)
            {
                // Circuit/page already gone; nothing to clean up.
            }
        }

        GC.SuppressFinalize(this);
    }
}
