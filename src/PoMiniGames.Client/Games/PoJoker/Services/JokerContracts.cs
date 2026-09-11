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
    /// The audience reaction to a punchline that landed — a filtered noise swell
    /// with a wobbling voice over it, plus a coin burst.
    /// </summary>
    /// <remarks>
    /// <b>This was implemented and unreachable.</b> <c>poJokerAudio.playLaughter</c>
    /// has existed in the interop module the whole time (and is one of only two
    /// places in the app that routed through the shared cue vocabulary), but it was
    /// never added to this interface, so no C# could call it. The effect was that
    /// PoJoker built a whole comedy stage — drum roll, fanfare, trombone, speech —
    /// in front of an audience that never laughed.
    /// </remarks>
    Task PlayLaughterAsync(double volume = 0.45);

    /// <summary>
    /// The ba-dum-tss sting for a joke that died. Unreachable for the same reason
    /// as <see cref="PlayLaughterAsync"/>.
    /// </summary>
    Task PlayRimshotAsync(double volume = 0.5);

    /// <summary>A brief, milder titter — for a reaction that is not a full laugh.</summary>
    Task PlayGiggleAsync(double volume = 0.4);

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
