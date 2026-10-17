using FluentAssertions;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGames.Unit.Features.Shared;

/// <summary>
/// The shared end-of-game moment: confetti only for a win or a new best, the grey vignette
/// only for a plain loss, a palette pulse only for a mood paletteBus has, and an unreported
/// result in the shared "ui" voice. One method, because the Unit tier is near its ceiling.
/// </summary>
public class GameOverMomentTests
{
    [Theory]
    [InlineData(GameResult.Win, false, true, false, ScreenFxService.Win, false)]
    [InlineData(GameResult.Loss, false, false, true, ScreenFxService.Lose, false)]
    [InlineData(GameResult.Loss, true, true, false, ScreenFxService.Lose, false)]
    [InlineData(GameResult.Draw, false, false, false, null, false)]
    [InlineData(GameResult.InProgress, false, false, false, null, true)]
    [InlineData(GameResult.InProgress, true, true, false, ScreenFxService.Win, true)]
    public void For_PicksOneMomentPerResult(
        GameResult outcome, bool newBest, bool confetti, bool vignette, string? mood, bool sharedScope)
    {
        var m = GameOverMoment.For(outcome, newBest);

        m.Confetti.Should().Be(confetti);
        m.Vignette.Should().Be(vignette);
        m.PaletteMood.Should().Be(mood);
        m.SharedScope.Should().Be(sharedScope);
        m.Cues.Should().NotBeEmpty();
        m.Haptic.Should().NotBeEmpty();
        // Every list ends on a name the shared "ui" scope defines, so some cue always sounds.
        m.Cues[^1].Should().BeOneOf("confirm", "error");
    }
}
