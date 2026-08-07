namespace PoMiniGamesClient.Models;

/// <summary>
/// How a match ended, from the local player's point of view. Reported to
/// <c>GameOverModal</c> so the end-of-game cue matches the result.
/// </summary>
/// <remarks>
/// <see cref="Unknown"/> is the default and is not a failure state: a game that
/// has no meaningful win condition for the local player (a demo, a local
/// 2-player round where "you" is ambiguous) should leave it unset and get the
/// neutral round-over cue. Guessing would mean celebrating losses.
/// </remarks>
public enum GameOutcome
{
    Unknown,
    Win,
    Loss,
    Draw,
}
