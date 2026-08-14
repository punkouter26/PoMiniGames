namespace PoMiniGamesClient.Games.PoJoker;

/// <summary>Interface for the PoJoker audio effect playback service (Web Audio API).</summary>
public interface IJokerAudioService
{
    Task InitializeAsync();
    Task PlayDrumRollAsync(double duration = 2.0, double volume = 0.5);
    Task PlayTromboneAsync(double volume = 0.6);
    Task PlayFanfareAsync(double volume = 0.5);
    Task PlayCymbalAsync(double volume = 0.4);

    /// <summary>
    /// Stop every currently-playing cue immediately. Oscillator cues (fanfare,
    /// trombone) play out on their envelope so they don't need cancellation,
    /// but buffer-source cues (drum roll, cymbal) would otherwise ring across
    /// the next state or after Stop. Safe to call when nothing is playing.
    /// </summary>
    Task StopAllAsync();
}

/// <summary>Interface for the PoJoker text-to-speech service (Web Speech API).</summary>
public interface IJokerSpeechService
{
    Task SpeakAsync(string text, double rate = 1.0, double pitch = 1.0);
    Task StopAsync();
    Task<bool> IsSpeakingAsync();
}
