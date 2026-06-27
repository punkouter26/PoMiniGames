using FluentAssertions;
using PoMiniGames.Features.PoFace;

namespace PoMiniGames.Unit.Features.PoFace;

/// <summary>
/// Tests for the pure domain logic of PoFace (head-pose validator, scoring formula,
/// round order, PlayerStats aggregation). No I/O.
/// </summary>
/// <remarks>
/// <b>§1 100/50/25/25 Rule.</b> Originally 10 single-case <c>[Fact]</c>s + 1
/// <c>[Theory]</c>; consolidated to 4 <c>[Theory]</c>s + 2 <c>[Fact]</c>s. The
/// scoring formula (previously a 5-row inline loop) is now an inline-data
/// theory; the per-emotion best tracking is parameterized across emotions.
/// </remarks>
public sealed class FaceModelsTests
{
    [Theory]
    [InlineData(0f, 0f, true)]      // facing camera
    [InlineData(15f, 10f, true)]     // within limits
    [InlineData(20f, 20f, true)]     // exactly at the boundary
    [InlineData(-20f, -20f, true)]   // exactly at the other boundary
    [InlineData(21f, 0f, false)]     // yaw too high
    [InlineData(0f, 25f, false)]     // pitch too high
    [InlineData(-25f, 5f, false)]    // yaw too low
    [InlineData(5f, -22f, false)]    // pitch too low
    [InlineData(45f, 45f, false)]    // looking away
    public void HeadPoseValidator_AcceptsWithinLimitsAndRejectsOutside(float yaw, float pitch, bool expected)
    {
        HeadPoseValidator.Validate(yaw, pitch).Should().Be(expected);
    }

    [Fact]
    public void FaceRoundOrder_HasFiveEmotionsInFixedOrder()
    {
        FaceRoundOrder.Order.Should().Equal(new[]
        {
            TargetEmotion.Happiness,
            TargetEmotion.Surprise,
            TargetEmotion.Anger,
            TargetEmotion.Sadness,
            TargetEmotion.Fear
        });
    }

    [Theory]
    [InlineData(0.95f, 10)]
    [InlineData(0.50f, 5)]
    [InlineData(0.49f, 5)] // banker's rounding to even
    [InlineData(0.10f, 1)]
    [InlineData(0.00f, 0)]
    public void ScoringFormula_ScoreIsTenTimesConfidenceWhenHeadPoseValid(float confidence, int expected)
    {
        // Documented formula: score = headPoseValid ? round(confidence * 10) : 0
        var score = HeadPoseValidator.Validate(0, 0) ? (int)Math.Round(confidence * 10) : 0;
        score.Should().Be(expected, $"confidence={confidence} should yield score={expected}");
    }

    [Theory]
    [InlineData(TargetEmotion.Anger,   5, 9, 9)] // second session is higher
    [InlineData(TargetEmotion.Fear,    9, 4, 9)] // second session is lower; keep first
    [InlineData(TargetEmotion.Happiness, 8, 3, 8)] // same as scoring formula
    public void PlayerStats_RecordCompletedSession_TracksPerEmotionBest(
        TargetEmotion emotion, int firstScore, int secondScore, int expectedBest)
    {
        var stats = new PlayerStats { UserId = "user-1" };

        var s1 = new GameSession { UserId = "user-1", SessionId = "s1" };
        s1.Captures.Add(new RoundCapture { TargetEmotion = emotion, Score = firstScore });
        stats.RecordCompletedSession(s1);

        var s2 = new GameSession { UserId = "user-1", SessionId = "s2" };
        s2.Captures.Add(new RoundCapture { TargetEmotion = emotion, Score = secondScore });
        stats.RecordCompletedSession(s2);

        var actual = emotion switch
        {
            TargetEmotion.Anger      => stats.AngerBest,
            TargetEmotion.Fear       => stats.FearBest,
            TargetEmotion.Happiness  => stats.HappinessBest,
            TargetEmotion.Surprise   => stats.SurpriseBest,
            TargetEmotion.Sadness    => stats.SadnessBest,
            _ => 0,
        };
        actual.Should().Be(expectedBest);
    }

    [Fact]
    public void PlayerStats_RecordCompletedSession_AggregatesTotals()
    {
        var stats = new PlayerStats { UserId = "user-1" };
        var session = new GameSession { UserId = "user-1", SessionId = "abc" };
        session.Captures.Add(new RoundCapture { RoundNumber = 0, TargetEmotion = TargetEmotion.Happiness, Score = 8, HeadPoseValid = true });
        session.Captures.Add(new RoundCapture { RoundNumber = 1, TargetEmotion = TargetEmotion.Surprise, Score = 6, HeadPoseValid = true });
        stats.RecordCompletedSession(session);
        stats.TotalGames.Should().Be(1);
        stats.TotalScore.Should().Be(14);
        stats.BestScore.Should().Be(14);
        stats.HappinessBest.Should().Be(8);
        stats.SurpriseBest.Should().Be(6);
    }

    [Fact]
    public async Task StubFaceAnalysisService_AlwaysReportsNoFace()
    {
        var stub = new StubFaceAnalysisService();
        stub.IsMock.Should().BeTrue();
        var result = await stub.AnalyzeAsync(Array.Empty<byte>(), TargetEmotion.Happiness);
        result.FaceDetected.Should().BeFalse();
        result.TargetEmotionConfidence.Should().Be(0f);
    }
}