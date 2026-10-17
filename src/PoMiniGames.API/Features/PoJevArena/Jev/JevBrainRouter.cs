using Microsoft.Extensions.Options;
using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGames.Features.PoJevArena.Jev;

/// <summary>
/// Picks the decision source for a match. Paid Jev answers only when the server offers it
/// (<see cref="JevOptions.Brain"/> = <see cref="JevBrain.Jev"/>, read per request), a key is
/// configured, and the player asked for it; everything else gets the free
/// <see cref="LocalJevClient"/>. Under the <c>Test</c> environment with
/// <see cref="JevOptions.UseStub"/> both sources are the deterministic stub, so test matches stay
/// reproducible and never reach OpenRouter.
/// </summary>
public sealed class JevBrainRouter(
    IJevClient paid,
    LocalJevClient local,
    StubJevClient stub,
    IOptionsSnapshot<JevOptions> options,
    IHostEnvironment environment)
{
    private bool StubAll => options.Value.UseStub && environment.IsEnvironment("Test");

    /// <summary>Whether a player who asks for the Jev brain gets it.</summary>
    public bool JevAvailable => options.Value.Brain == JevBrain.Jev && paid.IsConfigured;

    /// <summary>The brain a new match gets, given what the player asked for.</summary>
    public bool UseJevFor(string? requested) =>
        JevAvailable && string.Equals(requested, ArenaBrains.Jev, StringComparison.OrdinalIgnoreCase);

    public IJevClient For(bool usesJev) => StubAll ? stub : usesJev ? paid : local;
}
