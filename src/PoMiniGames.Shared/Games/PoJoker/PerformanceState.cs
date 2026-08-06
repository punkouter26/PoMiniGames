namespace PoMiniGames.Shared.Games.PoJoker;

/// <summary>
/// Represents the five-act performance state machine.
/// Per spec: Fetching -> Setup -> Guess -> Reveal -> Transition.
/// </summary>
public enum PerformanceState
{
    /// <summary>Initial idle state, awaiting user action to start.</summary>
    Idle = 0,

    /// <summary>Act 1: Fetching a new joke from JokeAPI.</summary>
    Fetching = 1,

    /// <summary>Act 2: Displaying the joke setup for ~3 seconds.</summary>
    ShowingSetup = 2,

    /// <summary>Act 3: AI predicts and displays its guess.</summary>
    ShowingAiGuess = 3,

    /// <summary>Act 4: Revealing actual punchline with triumph/defeat animation.</summary>
    RevealingPunchline = 4,

    /// <summary>Act 5: Brief transition before next performance cycle.</summary>
    Transitioning = 5,

    /// <summary>Final state: Comedy show complete (10 jokes delivered).</summary>
    Complete = 6
}
