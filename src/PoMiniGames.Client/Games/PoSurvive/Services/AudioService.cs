namespace PoSurvive.Client.Services;

using Microsoft.JSInterop;

// SOLID: SRP — owns only JS interop calls to audioEngine.js; no simulation logic
// Enhanced with Soundtrack Composer methods for layered audio control
public sealed class AudioService
{
    private readonly IJSRuntime _js;

    public AudioService(IJSRuntime js) => _js = js;

    // ─── Original SFX (GoF: Facade) ──────────────────────────────────────
    public async Task PlayForageAsync()  => await SafePlay("forage");
    public async Task PlayCombatAsync()  => await SafePlay("combat");
    public async Task PlayDeathAsync()   => await SafePlay("death");

    public async Task UnlockAudioAsync()
    {
        try { await _js.InvokeVoidAsync("audioEngine.unlockAudio"); }
        catch { /* swallow if AudioContext unavailable */ }
    }

    // ─── Soundtrack Composer: Ambient layer ───────────────────────────────
    public async Task StartAmbientAsync()
    {
        try { await _js.InvokeVoidAsync("audioEngine.startAmbient"); } catch { }
    }

    public async Task StopAmbientAsync()
    {
        try { await _js.InvokeVoidAsync("audioEngine.stopAmbient"); } catch { }
    }

    public async Task<bool> IsAmbientRunningAsync()
    {
        try { return await _js.InvokeAsync<bool>("audioEngine.isAmbientRunning"); } catch { return false; }
    }

    // ─── Soundtrack Composer: Heartbeat layer ─────────────────────────────
    public async Task StartHeartbeatAsync(float intensity = 0f)
    {
        try { await _js.InvokeVoidAsync("audioEngine.startHeartbeat", intensity); } catch { }
    }

    public async Task StopHeartbeatAsync()
    {
        try { await _js.InvokeVoidAsync("audioEngine.stopHeartbeat"); } catch { }
    }

    public async Task SetHeartbeatIntensityAsync(float intensity)
    {
        try { await _js.InvokeVoidAsync("audioEngine.setHeartbeatIntensity", intensity); } catch { }
    }

    // ─── Soundtrack Composer: Fanfares ────────────────────────────────────
    public async Task PlayVictoryFanfareAsync()
    {
        try { await _js.InvokeVoidAsync("audioEngine.playVictoryFanfare"); } catch { }
    }

    public async Task PlayDefeatFanfareAsync()
    {
        try { await _js.InvokeVoidAsync("audioEngine.playDefeatFanfare"); } catch { }
    }

    // ─── Soundtrack Composer: Layer volume control ────────────────────────
    public async Task SetLayerVolumeAsync(string layer, float volume)
    {
        try { await _js.InvokeVoidAsync("audioEngine.setLayerVolume", layer, volume); } catch { }
    }

    // ─── Soundtrack Composer: Dynamic intensity ──────────────────────────
    public async Task SetDynamicIntensityAsync(float intensity)
    {
        try { await _js.InvokeVoidAsync("audioEngine.setDynamicIntensity", intensity); } catch { }
    }

    // ─── Soundtrack Composer: Themes ──────────────────────────────────────
    public async Task SetThemeAsync(string theme)
    {
        try { await _js.InvokeVoidAsync("audioEngine.setTheme", theme); } catch { }
    }

    public async Task<string> GetThemeAsync()
    {
        try { return await _js.InvokeAsync<string>("audioEngine.getTheme"); } catch { return "tense"; }
    }

    public async Task<string[]> GetAvailableThemesAsync()
    {
        try { return await _js.InvokeAsync<string[]>("audioEngine.getAvailableThemes"); } catch { return []; }
    }

    // ─── Private helpers ──────────────────────────────────────────────────
    private async Task SafePlay(string eventType)
    {
        try   { await _js.InvokeVoidAsync("audioEngine.play", eventType); }
        catch { /* swallow JSException if audio API unavailable */ }
    }
}
