using FluentAssertions;
using PoShared.Games.PoJoker;

namespace PoMiniGames.UnitTests.Features.PoJoker;

/// <summary>
/// Tests for the PoJoker shared DTOs / settings — pure logic, no I/O.
/// </summary>
public sealed class JokerModelsTests
{
    private static JokeDto TwoPart() => new()
    {
        Id = 1,
        Type = "twopart",
        Setup = "Why did the chicken cross the road?",
        Punchline = "To get to the other side."
    };

    [Fact]
    public void JokeDto_TwoPart_DisplayTextIsSetup_FullTextJoinsBoth()
    {
        var joke = TwoPart();
        joke.DisplayText.Should().Be(joke.Setup);
        joke.FullText.Should().Be($"{joke.Setup}\n{joke.Punchline}");
    }

    [Fact]
    public void JokeDto_Single_DisplayTextAndFullTextAreTheOneLiner()
    {
        var joke = new JokeDto { Id = 2, Type = "single", Joke = "I'm reading a book about anti-gravity. It's impossible to put down." };
        joke.DisplayText.Should().Be(joke.Joke);
        joke.FullText.Should().Be(joke.Joke);
    }

    [Fact]
    public void JokeRatingDto_Average_IsMeanOfFourDimensions()
    {
        var rating = new JokeRatingDto { Cleverness = 8, Rudeness = 2, Complexity = 6, Difficulty = 4 };
        rating.Average.Should().Be(5.0); // (8+2+6+4)/4
    }

    [Fact]
    public void JokePerformanceDto_IsTriumph_MirrorsAnalysis()
    {
        var joke = TwoPart();
        var analysis = new JokeAnalysisDto { OriginalJoke = joke, AiPunchline = "x", IsTriumph = true };
        var perf = new JokePerformanceDto { SessionId = "s1", Joke = joke, Analysis = analysis };

        perf.IsTriumph.Should().BeTrue();
    }

    [Fact]
    public void JokePerformanceDto_DurationMs_IsNonNegative_ForOrderedTimestamps()
    {
        var joke = TwoPart();
        var analysis = new JokeAnalysisDto { OriginalJoke = joke, AiPunchline = "x" };
        var start = DateTimeOffset.UtcNow;
        var perf = new JokePerformanceDto
        {
            SessionId = "s1",
            Joke = joke,
            Analysis = analysis,
            StartedAt = start,
            CompletedAt = start.AddSeconds(3)
        };

        perf.DurationMs.Should().Be(3000); // exactly 3s in milliseconds
    }

    [Fact]
    public void PerformanceState_FollowsFiveActOrder()
    {
        // The orchestrator relies on monotonic ordering (CurrentState >= ShowingSetup, etc.).
        ((int)PerformanceState.Idle).Should().BeLessThan((int)PerformanceState.Fetching);
        ((int)PerformanceState.Fetching).Should().BeLessThan((int)PerformanceState.ShowingSetup);
        ((int)PerformanceState.ShowingSetup).Should().BeLessThan((int)PerformanceState.ShowingAiGuess);
        ((int)PerformanceState.ShowingAiGuess).Should().BeLessThan((int)PerformanceState.RevealingPunchline);
        ((int)PerformanceState.RevealingPunchline).Should().BeLessThan((int)PerformanceState.Transitioning);
        ((int)PerformanceState.Transitioning).Should().BeLessThan((int)PerformanceState.Complete);
    }

    [Fact]
    public void PerformanceSettings_Validate_PassesForDefaults()
    {
        var act = () => new PerformanceSettings().Validate();
        act.Should().NotThrow();
    }

    [Fact]
    public void PerformanceSettings_Validate_ThrowsOnNegativeValue()
    {
        var settings = new PerformanceSettings { SetupDurationSeconds = -1 };
        var act = () => settings.Validate();
        act.Should().Throw<InvalidOperationException>();
    }
}
