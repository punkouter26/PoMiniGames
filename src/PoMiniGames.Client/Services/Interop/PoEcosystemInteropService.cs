using System.Text.Json;
using Microsoft.JSInterop;
using PoMiniGamesClient.Games.PoEcosystem.Models;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Interop;

/// <summary>
/// Bridge to <c>window.PoEcosystem</c> (wwwroot/js/poecosystem/index.js). A
/// <see cref="DotNetObjectReference{T}"/> is handed to the engine, its callbacks
/// are re-raised as C# events, and dispose swallows
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
    public event Action<IReadOnlyList<EcoThought>>? ThoughtsReceived;   // island-wide thought feed
    public event Action<EcoDetail?>? DetailReceived;
    public event Action<int, EcoLineage?>? LineageReceived;      // handle, tree (null when forgotten)
    public event Action<EcoLlmState>? LlmStateReceived;
    public event Action<int>? Picked;
    public event Action<int>? SpeedChanged;
    public event Action<string, string?>? ActionRequested;       // dashboard, escape, map, pointerLock…
    public event Action<bool, string>? DirectorChanged;          // on, caption
    public event Action<bool>? PipChanged;
    public event Action<int, string>? Saved;
    public event Action<string, string>? EngineError;
    /// <summary>The engine has a gzip'd snapshot ready for the cloud (slot, bytes).</summary>
    public event Action<string, byte[]>? SnapshotExported;
    /// <summary>A creature wants a cloud thought (handle, system prompt, user prompt).</summary>
    public event Func<int, string, string, Task<string?>>? CloudThoughtRequested;

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

    public async ValueTask<bool> StartAsync(string containerId, string? minimapId, string? seed, bool resume, bool llmEnabled, string? modelId, bool lowEnd, bool demo = false)
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
            ["demo"] = demo,
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
    public ValueTask ExportTelemetryAsync() => SafeInvokeAsync("PoEcosystem.exportTelemetry");
    public ValueTask SetSoundAsync(bool on) => SafeInvokeAsync("PoEcosystem.setSound", on);
    public ValueTask RequestLockAsync() => SafeInvokeAsync("PoEcosystem.requestLock");
    public ValueTask ToggleFlyAsync() => SafeInvokeAsync("PoEcosystem.toggleFly");
    public ValueTask SetCameraPoseAsync(double x, double y, double z, double pitch, double yaw) =>
        SafeInvokeAsync("PoEcosystem.setPose", new { x, y, z, pitch, yaw });
    public ValueTask TouchMoveAsync(double x, double z) => SafeInvokeAsync("PoEcosystem.touchMove", x, z);
    public ValueTask TouchReleaseAsync() => SafeInvokeAsync("PoEcosystem.touchRelease");

    // ── lineage · watch-list · naming ────────────────────────────────────
    public ValueTask RequestLineageAsync(int handle) => SafeInvokeAsync("PoEcosystem.lineage", handle);
    public ValueTask RenameAsync(int handle, string name) => SafeInvokeAsync("PoEcosystem.rename", handle, name);
    public ValueTask WatchAsync(int handle, bool on) => SafeInvokeAsync("PoEcosystem.watch", handle, on);

    // ── evolution tint · director · pop-out ──────────────────────────────
    /// <summary>Colour every creature by one trait index (0–4), or -1 for species colours.</summary>
    public ValueTask SetTintAsync(int traitIndex) => SafeInvokeAsync("PoEcosystem.setTint", traitIndex);
    public ValueTask SetDirectorAsync(bool on) => SafeInvokeAsync("PoEcosystem.setDirector", on);
    public ValueTask TogglePipAsync() => SafeInvokeAsync("PoEcosystem.togglePip");

    // ── cloud saves ──────────────────────────────────────────────────────
    /// <summary>Ask the engine for a gzip'd snapshot; it answers through <see cref="SnapshotExported"/>.</summary>
    public ValueTask ExportSnapshotAsync(string slot) => SafeInvokeAsync("PoEcosystem.exportSnapshot", slot);
    /// <summary>Boot a world from gzip'd snapshot bytes. Ephemeral worlds never autosave over the local one.</summary>
    public ValueTask ImportSnapshotAsync(byte[] bytes, bool ephemeral) => SafeInvokeAsync("PoEcosystem.importSnapshot", bytes, ephemeral);

    // ── cloud thoughts ───────────────────────────────────────────────────
    /// <summary>Hand a server-side answer back to the creature that asked for it.</summary>
    public ValueTask DeliverCloudThoughtAsync(int handle, string? text) => SafeInvokeAsync("PoEcosystem.cloudThoughtResult", handle, text);

    /// <summary>Current ambience preference (engine-side, persisted in localStorage).</summary>
    public async ValueTask<bool> SoundEnabledAsync()
    {
        try { return await _js.InvokeAsync<bool>("PoEcosystem.soundEnabled"); }
        catch (JSException) { return true; }
        catch (JSDisconnectedException) { return true; }
    }

    // ── HUD prefs (raw localStorage; the engine's createPrefs namespace is engine-owned) ──
    /// <summary>Has this browser ever entered pointer lock? Fail-open: a broken storage
    /// means the hint may re-show, never that it stays hidden forever.</summary>
    public async ValueTask<bool> LockHintSeenAsync()
    {
        try { return await _js.InvokeAsync<string?>("localStorage.getItem", "poeco:lockHintSeen") == "1"; }
        catch (JSException) { return true; }
        catch (JSDisconnectedException) { return true; }
    }

    public ValueTask MarkLockHintSeenAsync() => SafeInvokeAsync("localStorage.setItem", "poeco:lockHintSeen", "1");

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
    public void OnThoughts(string json)
    {
        var thoughts = Deserialize(json, EcoJsonContext.Default.EcoThoughtArray);
        if (thoughts is { Length: > 0 }) ThoughtsReceived?.Invoke(thoughts);
    }

    [JSInvokable]
    public void OnDetail(string? json) =>
        DetailReceived?.Invoke(string.IsNullOrEmpty(json) ? null : Deserialize(json, EcoJsonContext.Default.EcoDetail));

    [JSInvokable]
    public void OnLineage(int handle, string? json) =>
        LineageReceived?.Invoke(handle, string.IsNullOrEmpty(json) ? null : Deserialize(json, EcoJsonContext.Default.EcoLineage));

    [JSInvokable]
    public void OnLlmState(string json)
    {
        var state = Deserialize(json, EcoJsonContext.Default.EcoLlmState);
        if (state is not null) LlmStateReceived?.Invoke(state);
    }

    [JSInvokable] public void OnPick(int handle) => Picked?.Invoke(handle);
    [JSInvokable] public void OnSpeed(int speed) => SpeedChanged?.Invoke(speed);
    [JSInvokable] public void OnAction(string action, string? value) => ActionRequested?.Invoke(action, value);
    [JSInvokable] public void OnDirector(bool on, string? caption) => DirectorChanged?.Invoke(on, caption ?? string.Empty);
    [JSInvokable] public void OnPip(bool on) => PipChanged?.Invoke(on);
    [JSInvokable] public void OnSaved(int tick, string reason) => Saved?.Invoke(tick, reason);
    [JSInvokable] public void OnEngineError(string where, string message) => EngineError?.Invoke(where, message);
    [JSInvokable] public void OnSnapshotBytes(string slot, byte[] bytes) => SnapshotExported?.Invoke(slot, bytes);

    /// <summary>
    /// A creature's cloud-thought request. Answered by whoever subscribed (the viewer, which
    /// owns the API client); an unanswered request gets null so the sim moves on.
    /// </summary>
    [JSInvokable]
    public async Task<string?> OnCloudThought(int handle, string system, string prompt)
    {
        var handler = CloudThoughtRequested;
        if (handler is null) return null;
        try { return await handler(handle, system, prompt); }
        catch { return null; }
    }

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
