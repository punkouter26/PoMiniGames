namespace PoMiniGamesClient.Games.PoJoker;

/// <summary>Interface for the PoJoker audio effect playback service (Web Audio API).</summary>
public interface IJokerAudioService
{
    Task InitializeAsync();
    Task PlayDrumRollAsync(double duration = 2.0, double volume = 0.5);
    Task PlayTromboneAsync(double volume = 0.6);
    Task PlayFanfareAsync(double volume = 0.5);
    Task PlayCymbalAsync(double volume = 0.4);
}

/// <summary>Interface for the PoJoker text-to-speech service (Web Speech API).</summary>
public interface IJokerSpeechService
{
    Task SpeakAsync(string text, double rate = 1.0, double pitch = 1.0);
    Task StopAsync();
    Task<bool> IsSpeakingAsync();
}
