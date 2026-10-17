using FluentAssertions;
using PoMiniGames.Features.PoCoupleQuiz;

namespace PoMiniGames.Unit.Features.PoCoupleQuiz;

/// <summary>
/// The free CoupleQuiz answer matcher. Each row names the band the pair must land in:
/// <c>match</c> (scored without any model), <c>close</c> (the only band the optional AI judge is
/// ever asked about, and not a match on the free path), or <c>miss</c>.
/// </summary>
public sealed class AnswerMatcherTests
{
    [Theory]
    [InlineData("Pizza", "pizza!", "match")]                    // case and punctuation
    [InlineData("The Beatles", "beatles", "match")]             // articles and plurals
    [InlineData("puppies", "Dog", "match")]                     // plural folded, then synonym
    [InlineData("NYC", "New York City", "match")]               // multi-word synonym
    [InlineData("3", "three", "match")]                         // number words
    [InlineData("pepperoni pizza", "pizza", "match")]           // one answer contains the other
    [InlineData("chocolate", "chocolat", "match")]              // typo in a long word
    [InlineData("horse", "house", "close")]                     // one letter apart in a short word
    [InlineData("pizza", "pasta", "miss")]
    [InlineData("cat", "banana", "miss")]
    [InlineData("", "anything", "miss")]
    public void Score_LandsInTheExpectedBand(string king, string guess, string band)
    {
        var score = AnswerMatcher.Score(king, guess);
        AnswerMatcher.Score(guess, king).Should().BeApproximately(score, 1e-5f, because: "order of the two answers must not matter");

        switch (band)
        {
            case "match":
                score.Should().BeGreaterThanOrEqualTo(AnswerMatcher.AmbiguousHigh);
                break;
            case "close":
                AnswerMatcher.IsAmbiguous(score).Should().BeTrue();
                score.Should().BeLessThan(AnswerMatcher.MatchThreshold);
                break;
            default:
                score.Should().BeLessThan(AnswerMatcher.AmbiguousLow);
                break;
        }
    }
}
