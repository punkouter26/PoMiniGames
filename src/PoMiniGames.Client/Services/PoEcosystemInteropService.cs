using System.Text.Json;
using Microsoft.JSInterop;
using PoMiniGamesClient.Games.PoEcosystem.Models;

namespace PoMiniGamesClient.Services;

/// <summary>
/// Bridge to <c>window.PoEcosystem</c> (wwwroot/js/poecosystem/index.js). Mirrors
/// <see cref="SubSurfaceInteropService"/>: a <see cref="DotNetObjectReference{T}"/> is handed to
/// the engine, its callbacks are re-raised as C# events, and dispose swallows
/// <see cref="JSDisconnectedException"/> because the circuit may already be gone.
///
/// The engine is loaded through <c>engineLoader.js</c> (route-gated), so nothing here runs
/// until a page actually mounts the game.
/// </summary>
public sealed class PoEcosystemInteropService : IAsyncDisposable
{
    private readonly IJSRuntime _js;
    private DotNetObjectReference<PoEcosystemInteropService>? _self;
    private bool _started;

    public PoEcosystemInteropService(IJSRuntime js) => _js = js;

    public event Action<int, int, bool, string>? Ready;          // seed, tick, resumed, physics kind
    public event Action<EcoStats>? StatsReceived;
    public event Action<IReadOnlyList<EcoEvent>>? EventsReceived;
    public event Action<EcoDetail?>? DetailReceived;
    public event Action<EcoLlmState>? LlmStateReceived;
    public event Action<int>? Picked;
    public event Action<int>? SpeedChanged;
    public event Action<string, string?>? ActionRequested;       // dashboard, escape, map, pointerLock…
    public event Action<int, string>? Saved;
    public event Action<string, string>? EngineError;

    /// <summary>Is there a world in IndexedDB to resume?</summary>
    public async ValueTask<EcoSaveInfo> ProbeSaveAsync()
    {
        try
        {
            if (!await LoadEngineAsync()) return new EcoSaveInfo(false, 0, 0, 0, 0, null);
            var json = await _js.InvokeAsync<string?>("JSON.stringify", await _js.InvokeAsync<object>("PoEcosystem.probeSave"));
            if (string.IsNullOrWhiteSpace(json)) return new EcoSaveInfo(false, 0, 0, 0, 0, null);
            return JsonSerializer.Deserialize(json, EcoJsonContext.Default.EcoSaveInfo) ?? new EcoSaveInfo(false, 0, 0, 0, 0, null);
        }
        catch (JSException) { return new EcoSaveInfo(false, 0, 0, 0, 0, null); }
        catch (JSDisconnectedException) { return new EcoSaveInfo(false, 0, 0, 0, 0, null); }
    }

    public async ValueTask<bool> StartAsync(string containerId, string? minimapId, string? seed, bool resume, bool llmEnabled, string? modelId, bool lowEnd)
    {
        if (!await LoadEngineAsync()) return false;
        _self ??= DotNetObjectReference.Create(this);
        var options = new Dictionary<string, object?>
        {
            ["seed"] = seed ?? string.Empty,
            ["resume"] = resume,
            ["llmEnabled"] = llmEnabled,
            ["modelId"] = modelId,
            ["lowEnd"] = lowEnd,
            ["minimapId"] = minimapId,
        };
        _started = await _js.InvokeAsync<bool>("PoEcosystem.start", containerId, _self, options);
        return _started;
    }

    public ValueTask SetSpeedAsync(int speed) => SafeInvokeAsync("PoEcosystem.setSpeed", speed);
    public ValueTask SelectAsync(int handle) => SafeInvokeAsync("PoEcosystem.select", handle);
    public ValueTask FollowAsync(int handle) => SafeInvokeAsync("PoEcosystem.follow", handle);
    public ValueTask NewWorldAsync(string? seed) => SafeInvokeAsync("PoEcosystem.newWorld", seed ?? string.Empty);
    public ValueTask SetLlmAsync(bool enabled, string? modelId) => SafeInvokeAsync("PoEcosystem.setLlm", enabled, modelId);
    public ValueTask SaveNowAsync() => SafeInvokeAsync("PoEcosystem.saveNow");
    public ValueTask DebugAsync(string op) => SafeInvokeAsync("PoEcosystem.debug", op);
    public ValueTask RequestLockAsync() => SafeInvokeAsync("PoEcosystem.requestLock");
    public ValueTask ToggleFlyAsync() => SafeInvokeAsync("PoEcosystem.toggleFly");
    public ValueTask TouchMoveAsync(double x, double z) => SafeInvokeAsync("PoEcosystem.touchMove", x, z);
    public ValueTask TouchReleaseAsync() => SafeInvokeAsync("PoEcosystem.touchRelease");

    public async ValueTask<bool> WebGpuAvailableAsync()
    {
        try { return await _js.InvokeAsync<bool>("PoEcosystem.webGpuAvailable"); }
        catch (JSException) { return false; }
        catch (JSDisconnectedException) { return false; }
    }

    public async ValueTask<IReadOnlyList<EcoModel>> ModelsAsync()
    {
        try
        {
            var json = await _js.InvokeAsync<string>("JSON.stringify", await _js.InvokeAsync<object>("PoEcosystem.models"));
            return JsonSerializer.Deserialize(json, EcoJsonContext.Default.EcoModelArray) ?? [];
        }
        catch (JSException) { return []; }
        catch (JSDisconnectedException) { return []; }
    }

    // ── callbacks from the engine ────────────────────────────────────────
    [JSInvokable] public void OnReady(int seed, int tick, bool resumed, string physics) => Ready?.Invoke(seed, tick, resumed, physics);

    [JSInvokable]
    public void OnStats(string json)
    {
        var stats = Deserialize(json, EcoJsonContext.Default.EcoStats);
        if (stats is not null) StatsReceived?.Invoke(stats);
    }

    [JSInvokable]
    public void OnEvents(string json)
    {
        var events = Deserialize(json, EcoJsonContext.Default.EcoEventArray);
        if (events is { Length: > 0 }) EventsReceived?.Invoke(events);
    }

    [JSInvokable]
    public void OnDetail(string? json) =>
        DetailReceived?.Invoke(string.IsNullOrEmpty(json) ? null : Deserialize(json, EcoJsonContext.Default.EcoDetail));

    [JSInvokable]
    public void OnLlmState(string json)
    {
        var state = Deserialize(json, EcoJsonContext.Default.EcoLlmState);
        if (state is not null) LlmStateReceived?.Invoke(state);
    }

    [JSInvokable] public void OnPick(int handle) => Picked?.Invoke(handle);
    [JSInvokable] public void OnSpeed(int speed) => SpeedChanged?.Invoke(speed);
    [JSInvokable] public void OnAction(string action, string? value) => ActionRequested?.Invoke(action, value);
    [JSInvokable] public void OnSaved(int tick, string reason) => Saved?.Invoke(tick, reason);
    [JSInvokable] public void OnEngineError(string where, string message) => EngineError?.Invoke(where, message);

    private async ValueTask<bool> LoadEngineAsync()
    {
        try { return await _js.InvokeAsync<bool>("loadEngine", "poecosystem"); }
        catch (JSException) { return false; }
        catch (JSDisconnectedException) { return false; }
    }

    private async ValueTask SafeInvokeAsync(string identifier, params object?[] args)
    {
        if (!_started) return;
        try { await _js.InvokeVoidAsync(identifier, args); }
        catch (JSException) { /* the engine is gone or not started */ }
        catch (JSDisconnectedException) { /* circuit closed */ }
    }

    private static T? Deserialize<T>(string json, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> info)
    {
        try { return JsonSerializer.Deserialize(json, info); }
        catch (JsonException) { return default; }
    }

    public async ValueTask DisposeAsync()
    {
        if (_started)
        {
            try { await _js.InvokeVoidAsync("PoEcosystem.stop"); }
            catch (JSException) { /* ignore */ }
            catch (JSDisconnectedException) { /* ignore */ }
        }
        _self?.Dispose();
        _self = null;
        _started = false;
    }
}
