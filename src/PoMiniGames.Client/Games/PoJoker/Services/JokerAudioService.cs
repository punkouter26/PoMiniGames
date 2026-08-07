using Microsoft.Extensions.Logging;
using Microsoft.JSInterop;

namespace PoMiniGamesClient.Games.PoJoker;

/// <summary>
/// Plays audio effects via the Web Audio API (programmatic drum roll, trombone, fanfare,
/// cymbal). Interop entry points live in <c>wwwroot/js/pojoker-audio-interop.js</c> under the
/// <c>poJokerAudio</c> global. Failures are swallowed (audio is non-essential).
/// </summary>
public sealed class JokerAudioService(IJSRuntime jsRuntime, ILogger<JokerAudioService> logger) : IJokerAudioService
{
    private readonly IJSRuntime _jsRuntime = jsRuntime;
    private readonly ILogger<JokerAudioService> _logger = logger;
    private bool _initialized;

    public async Task InitializeAsync()
    {
        if (_initialized) return;
        try
        {
            // Fetch the interop script here rather than from a <script> tag in
            // index.html. It used to load on every page in the app — 9 KB parsed
            // by every player, for a global only this one game ever calls. The
            // module assigns window.poJokerAudio on evaluation, so importing it
            // is what makes the calls below resolve; the browser's module cache
            // makes a repeat import free.
            await _jsRuntime.InvokeAsync<IJSObjectReference>("import", "./js/pojoker-audio-interop.js");
            await _jsRuntime.InvokeVoidAsync("poJokerAudio.init");
            _initialized = true;
        }
        catch (JSException ex)
        {
            _logger.LogWarning(ex, "Failed to initialize PoJoker audio");
        }
    }

    public async Task PlayDrumRollAsync(double duration = 2.0, double volume = 0.5)
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerAudio.playDrumRoll", duration, volume); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to play drum roll"); }
    }

    public async Task PlayTromboneAsync(double volume = 0.6)
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerAudio.playTrombone", volume); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to play trombone"); }
    }

    public async Task PlayFanfareAsync(double volume = 0.5)
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerAudio.playFanfare", volume); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to play fanfare"); }
    }

    public async Task PlayCymbalAsync(double volume = 0.4)
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerAudio.playCymbal", volume); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to play cymbal"); }
    }
}
