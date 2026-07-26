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

    // §7 Haptic vocabulary. Each intent below pairs its audio cue with a short
    // vibration so the same feedback lands on tactile-first mobile players (and
    // in silent/pocket contexts). Patterns are deliberately tiny — a "tick", not
    // a "buzz" — so rapid interactions never fatigue. All are best-effort and
    // gated on the same master-mute as audio (see uiAudio.js `vibrate`).
    private static readonly int[] HapticTap = { 8 };
    private static readonly int[] HapticClick = { 6 };
    private static readonly int[] HapticDrop = { 14 };
    private static readonly int[] HapticComplete = { 12, 28, 12 };
    private static readonly int[] HapticError = { 40 };
    private static readonly int[] HapticStart = { 10, 30, 16 };

    /// <summary>A short tap (40 ms, A5, 18 % gain + light haptic tick) for button presses.</summary>
    public async ValueTask TapAsync()
    {
        await PlayToneAsync(880, 40, 0.18, "triangle");
        await VibrateAsync(HapticTap);
    }

    /// <summary>A bright completion cue (220 ms C-E-G chord at 12 % gain + haptic).</summary>
    public async ValueTask CompleteAsync()
    {
        await PlayChordAsync(new[] { 523.25, 659.25, 783.99 }, 220, 0.12);
        await VibrateAsync(HapticComplete);
    }

    /// <summary>A low error buzz (120 ms A3 square wave at 22 % gain + haptic buzz).</summary>
    public async ValueTask ErrorAsync()
    {
        await PlayToneAsync(220, 120, 0.22, "square");
        await VibrateAsync(HapticError);
    }

    /// <summary>A confident game-start chord (280 ms G-C-E triangle at 15 % gain + haptic).</summary>
    public async ValueTask GameStartAsync()
    {
        await PlayChordAsync(new[] { 392.00, 523.25, 659.25 }, 280, 0.15);
        await VibrateAsync(HapticStart);
    }

    /// <summary>A subtle UI confirmation (60 ms C6 sine, 10 % gain + faint haptic).</summary>
    public async ValueTask ClickAsync()
    {
        await PlayToneAsync(1046.50, 60, 0.10, "sine");
        await VibrateAsync(HapticClick);
    }

    /// <summary>
    /// A disc-drop "tock" (75 ms, low triangle at 20 % gain + haptic) synced to a
    /// piece landing in a Connect-style board. Deliberately low and short so rapid
    /// moves don't fatigue — the settle-bounce visual and this cue fire together.
    /// </summary>
    public async ValueTask DiscDropAsync()
    {
        await PlayToneAsync(174.61, 75, 0.20, "triangle");
        await VibrateAsync(HapticDrop);
    }

    /// <summary>
    /// Realistic Connect-style chip-drop cue. Plays a band-passed noise slide
    /// (chip scraping down the slot) followed by a thud + click on landing. The
    /// landing row (0..8, where 8 = bottom of board) shifts the thud frequency
    /// and decay slightly so high drops sound thinner than low drops. Fires a
    /// short haptic at the impact moment so the cue lands on tactile devices.
    /// Best-effort; silent on autoplay-blocked / no-AudioContext environments.
    /// </summary>
    /// <param name="rowIndex">0..8 — the row the chip landed on (8 = bottom).</param>
    public async ValueTask ChipDropAsync(int rowIndex)
    {
        if (_disposed) return;
        try
        {
            var module = await _module.Value;
            // Match the CSS drop length: the slide takes ~400 ms so it
            // synchronises with cf-slide-down's 0.55s easing as the disc
            // crosses the board. The thud fires at ~0.40s — feels "with" the
            // settle bounce.
            await module.InvokeVoidAsync("playChipDrop", new
            {
                rowIndex,
                slideMs = 400,
                thudMs = 110,
                masterGain = 0.22,
            });
            await module.InvokeVoidAsync("vibrate", HapticDrop);
        }
        catch
        {
            // Best-effort — never throw from a feedback path.
        }
    }

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

    /// <summary>
    /// §7 Fire a raw haptic pattern (alternating vibrate/pause milliseconds, e.g.
    /// <c>[12, 40, 18]</c>). Gated on <c>navigator.vibrate</c> support and the
    /// global master-mute; a no-op on desktop/unsupported devices. Best-effort —
    /// never throws. Games can call this directly for bespoke cues (hit, near-miss,
    /// countdown) beyond the shared intents above.
    /// </summary>
    public async ValueTask VibrateAsync(int[] pattern)
    {
        if (_disposed || pattern is not { Length: > 0 }) return;
        try
        {
            var module = await _module.Value;
            await module.InvokeVoidAsync("vibrate", pattern);
        }
        catch
        {
            // Best-effort — never throw from a feedback path.
        }
    }

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
