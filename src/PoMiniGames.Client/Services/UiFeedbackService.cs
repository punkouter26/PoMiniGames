using Microsoft.JSInterop;

namespace PoMiniGamesClient.Services;

/// <summary>
/// §5 Native Web Audio micro-feedback service. Generates triangle/sine oscillator
/// bursts at the call site — zero audio assets to ship. Lazy <c>AudioContext</c>
/// init on first invocation (honours mobile autoplay rules; the first tap will
/// fall back to no-op if the gesture has not happened).
/// </summary>
/// <remarks>
/// <para>
/// Pattern: Adapter. The Blazor layer speaks <see cref="Task"/>; the underlying
/// store is the browser's Web Audio API. The adapter maps semantic feedback
/// intents (<see cref="TapAsync"/>, <see cref="CompleteAsync"/>, <see cref="ErrorAsync"/>,
/// <see cref="GameStartAsync"/>) to a fixed chord + envelope so every game
/// shares the same audio vocabulary.
/// </para>
/// <para>
/// <b>Failure modes</b>: silent. If the AudioContext is unavailable (very old
/// browsers, sandboxed iframes, autoplay blocked before the first gesture) the
/// JS module throws and the await swallows it — feedback is best-effort, never
/// a blocker.
/// </para>
/// </remarks>
public sealed class UiFeedbackService : IAsyncDisposable
{
    private readonly Lazy<Task<IJSObjectReference>> _module;
    private bool _disposed;

    public UiFeedbackService(IJSRuntime js)
    {
        _module = new Lazy<Task<IJSObjectReference>>(() =>
            js.InvokeAsync<IJSObjectReference>("import", "./js/uiAudio.js").AsTask());
    }

    /// <summary>A short tap (40 ms, A5, 18 % gain) for button presses.</summary>
    public ValueTask TapAsync() => PlayToneAsync(880, 40, 0.18, "triangle");

    /// <summary>A bright completion cue (220 ms C-E-G chord at 12 % gain).</summary>
    public ValueTask CompleteAsync() => PlayChordAsync(new[] { 523.25, 659.25, 783.99 }, 220, 0.12);

    /// <summary>A low error buzz (120 ms A3 square wave at 22 % gain).</summary>
    public ValueTask ErrorAsync() => PlayToneAsync(220, 120, 0.22, "square");

    /// <summary>A confident game-start chord (280 ms G-C-E triangle at 15 % gain).</summary>
    public ValueTask GameStartAsync() => PlayChordAsync(new[] { 392.00, 523.25, 659.25 }, 280, 0.15);

    /// <summary>A subtle UI confirmation (60 ms C6 sine, 10 % gain).</summary>
    public ValueTask ClickAsync() => PlayToneAsync(1046.50, 60, 0.10, "sine");

    /// <summary>
    /// §10 Swipe-back gesture feedback — a 90 ms downsweep from C5 → A3 with
    /// a soft attack. Matches the navigation gesture direction (low = leaving).
    /// </summary>
    public ValueTask SwipeBackAsync() => PlaySweepAsync(523.25, 220.00, 90, 0.14, "triangle");

    /// <summary>
    /// §10 Personal-best celebration — three ascending arpeggio notes (C5 → E5 → G5)
    /// with a short vibration burst on supporting devices. The audio is the
    /// milestone cue; the haptic reinforces it for tactile-first users.
    /// </summary>
    public ValueTask PersonalBestAsync() => PlayArpeggioAsync(
        new[] { 523.25, 659.25, 783.99 },
        new[] { 80, 80, 180 },
        0.16,
        vibrate: new[] { 12, 40, 18 });

    /// <summary>
    /// §10 Mock-data environment cue — a single low buzz (140 ms, F3, 14 % gain)
    /// whenever the USING MOCK DATA banner appears. Best-effort, never blocks.
    /// </summary>
    public ValueTask MockDataAsync() => PlayToneAsync(174.61, 140, 0.14, "square");

    private async ValueTask PlayToneAsync(double freq, int ms, double gain, string type)
    {
        if (_disposed) return;
        try
        {
            var module = await _module.Value;
            await module.InvokeVoidAsync("playTone", freq, ms, gain, type);
        }
        catch
        {
            // Best-effort — never throw from a feedback path.
        }
    }

    private async ValueTask PlayChordAsync(double[] freqs, int ms, double gain)
    {
        if (_disposed) return;
        try
        {
            var module = await _module.Value;
            await module.InvokeVoidAsync("playChord", freqs, ms, gain);
        }
        catch
        {
            // Best-effort — never throw from a feedback path.
        }
    }

    private async ValueTask PlaySweepAsync(double fromHz, double toHz, int ms, double gain, string type)
    {
        if (_disposed) return;
        try
        {
            var module = await _module.Value;
            await module.InvokeVoidAsync("playSweep", fromHz, toHz, ms, gain, type);
        }
        catch
        {
            // Best-effort.
        }
    }

    private async ValueTask PlayArpeggioAsync(double[] freqs, int[] durationsMs, double gain, int[]? vibrate)
    {
        if (_disposed) return;
        try
        {
            var module = await _module.Value;
            await module.InvokeVoidAsync("playArpeggio", freqs, durationsMs, gain);
            if (vibrate is { Length: > 0 })
            {
                await module.InvokeVoidAsync("vibrate", vibrate);
            }
        }
        catch
        {
            // Best-effort.
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        if (_module.IsValueCreated)
        {
            try
            {
                var module = await _module.Value;
                await module.DisposeAsync();
            }
            catch { /* module never loaded — fine */ }
        }
    }
}