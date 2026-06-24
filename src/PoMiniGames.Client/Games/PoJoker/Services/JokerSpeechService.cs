using Microsoft.Extensions.Logging;
using Microsoft.JSInterop;

namespace PoMiniGamesClient.Games.PoJoker;

/// <summary>
/// Text-to-speech via the Web Speech API with a British male voice preference. Interop entry
/// points live in <c>wwwroot/js/pojoker-speech-interop.js</c> under the <c>poJokerSpeech</c>
/// global. Failures are swallowed (narration is non-essential).
/// </summary>
public sealed class JokerSpeechService(IJSRuntime jsRuntime, ILogger<JokerSpeechService> logger) : IJokerSpeechService
{
    private readonly IJSRuntime _jsRuntime = jsRuntime;
    private readonly ILogger<JokerSpeechService> _logger = logger;

    public async Task SpeakAsync(string text, double rate = 1.0, double pitch = 1.0)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        try { await _jsRuntime.InvokeVoidAsync("poJokerSpeech.speak", text, rate, pitch); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to speak text"); }
    }

    public async Task StopAsync()
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerSpeech.stop"); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to stop speech"); }
    }

    public async Task<bool> IsSpeakingAsync()
    {
        try { return await _jsRuntime.InvokeAsync<bool>("poJokerSpeech.isSpeaking"); }
        catch (JSException) { return false; }
    }
}
