namespace PoMiniGamesClient.Games.PoSurvive.Services;

using Microsoft.JSInterop;

// SOLID: SRP — owns only JS interop calls to audioEngine.js; no simulation logic.
//
// Scope note: this is the surface AudioEffects actually drives from simulation events.
// The mixer/theme API (setLayerVolume, get/setTheme, getAvailableThemes,
// isAmbientRunning, setHeartbeatIntensity, unlockAudio) was removed with the
// SoundtrackControl panel — that component was its only caller and was never rendered.
public sealed class AudioService
{
    private readonly IJSRuntime _js;

    public AudioService(IJSRuntime js) => _js = js;

    // ─── SFX (GoF: Facade) ───────────────────────────────────────────────
    public async Task PlayForageAsync() => await SafePlay("forage");
    public async Task PlayCombatAsync() => await SafePlay("combat");
    public async Task PlayDeathAsync() => await SafePlay("death");

    // ─── Ambient layer ────────────────────────────────────────────────────
    public async Task StartAmbientAsync()
    {
        try { await _js.InvokeVoidAsync("audioEngine.startAmbient"); } catch { }
    }

    public async Task StopAmbientAsync()
    {
        try { await _js.InvokeVoidAsync("audioEngine.stopAmbient"); } catch { }
    }

    // ─── Heartbeat layer ──────────────────────────────────────────────────
    public async Task StartHeartbeatAsync(float intensity = 0f)
    {
        try { await _js.InvokeVoidAsync("audioEngine.startHeartbeat", intensity); } catch { }
    }

    public async Task StopHeartbeatAsync()
    {
        try { await _js.InvokeVoidAsync("audioEngine.stopHeartbeat"); } catch { }
    }

    // ─── Fanfares ─────────────────────────────────────────────────────────
    public async Task PlayVictoryFanfareAsync()
    {
        try { await _js.InvokeVoidAsync("audioEngine.playVictoryFanfare"); } catch { }
    }

    public async Task PlayDefeatFanfareAsync()
    {
        try { await _js.InvokeVoidAsync("audioEngine.playDefeatFanfare"); } catch { }
    }

    // ─── Dynamic intensity (scaled per turn from combat activity) ─────────
    public async Task SetDynamicIntensityAsync(float intensity)
    {
        try { await _js.InvokeVoidAsync("audioEngine.setDynamicIntensity", intensity); } catch { }
    }

    // ─── Private helpers ──────────────────────────────────────────────────
    private async Task SafePlay(string eventType)
    {
        try { await _js.InvokeVoidAsync("audioEngine.play", eventType); }
        catch { /* swallow JSException if audio API unavailable */ }
    }
}
