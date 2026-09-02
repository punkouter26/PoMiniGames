using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using PoMiniGamesClient.Models.SubSurface;

namespace PoMiniGamesClient.Services;

public sealed class SubSurfaceInteropService : IAsyncDisposable
{
    private readonly IJSRuntime _jsRuntime;
    private IJSObjectReference? _module;
    private DotNetObjectReference<SubSurfaceInteropService>? _dotNetHelper;

    public event Action<SubSurfaceDiagnostics>? OnMetricsReceived;
    public event Action<SubSurfaceRealismStatus>? OnRealismStatusReceived;

    public SubSurfaceInteropService(IJSRuntime jsRuntime)
    {
        _jsRuntime = jsRuntime;
    }

    public async ValueTask InitializeAsync(ElementReference canvas, SubSurfaceRealism realism)
    {
        _dotNetHelper = DotNetObjectReference.Create(this);
        _module = await _jsRuntime.InvokeAsync<IJSObjectReference>(
            "import", "./js/subsurface/subsurface-engine.js");

        await _module.InvokeVoidAsync("initSubSurface", canvas, _dotNetHelper, (byte)realism);
    }

    public async ValueTask SetRealismAsync(SubSurfaceRealism realism)
    {
        if (_module is not null)
        {
            await _module.InvokeVoidAsync("setSubSurfaceRealism", (byte)realism);
        }
    }

    public async ValueTask SetToolAsync(SubSurfaceTool tool)
    {
        if (_module is not null)
        {
            await _module.InvokeVoidAsync("setSubSurfaceTool", (byte)tool);
        }
    }

    public async ValueTask SetAutoDropAsync(bool enabled)
    {
        if (_module is not null)
        {
            await _module.InvokeVoidAsync("setSubSurfaceAutoDrop", enabled);
        }
    }

    public async ValueTask SetBrushRadiusAsync(int radius)
    {
        if (_module is not null)
        {
            await _module.InvokeVoidAsync("setSubSurfaceBrushRadius", radius);
        }
    }

    public async ValueTask SetPausedAsync(bool isPaused)
    {
        if (_module is not null)
        {
            await _module.InvokeVoidAsync("setSubSurfacePaused", isPaused);
        }
    }

    public async ValueTask StepOnceAsync()
    {
        if (_module is not null)
        {
            await _module.InvokeVoidAsync("stepSubSurface");
        }
    }

    public async ValueTask LoadPresetAsync(SubSurfacePreset preset)
    {
        if (_module is not null)
        {
            await _module.InvokeVoidAsync("loadSubSurfacePreset", preset.ToString());
        }
    }

    public async ValueTask ResetAsync()
    {
        if (_module is not null)
        {
            await _module.InvokeVoidAsync("resetSubSurface");
        }
    }

    public async ValueTask SetAudioEnabledAsync(bool enabled)
    {
        if (_module is not null)
        {
            await _module.InvokeVoidAsync("setSubSurfaceAudio", enabled);
        }
    }

    [JSInvokable]
    public void OnEngineMetricsUpdate(SubSurfaceDiagnostics diagnostics)
    {
        OnMetricsReceived?.Invoke(diagnostics);
    }

    [JSInvokable]
    public void OnRealismStatus(SubSurfaceRealismStatus status)
    {
        OnRealismStatusReceived?.Invoke(status);
    }

    public async ValueTask DisposeAsync()
    {
        if (_module is not null)
        {
            try
            {
                await _module.InvokeVoidAsync("disposeSubSurface");
                await _module.DisposeAsync();
            }
            catch (JSDisconnectedException)
            {
                // Circuit or page was disconnected
            }
        }

        _dotNetHelper?.Dispose();
    }
}
