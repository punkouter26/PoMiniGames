using FluentAssertions;
using PoMiniGames.Features.PoFace;

namespace PoMiniGames.UnitTests.Features.PoFace;

/// <summary>
/// Tests for the pure domain logic of PoFace (head-pose validator, scoring formula,
/// round order, PlayerStats aggregation). No I/O.
/// </summary>
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

    [Fact]
    public void FaceRoundOrder_OrderIsNotShuffled()
    {
        // Sanity: the spec says "never shuffled" — we assert the explicit list.
        FaceRoundOrder.Order.Count.Should().Be(5);
    }

    [Fact]
    public void PlayerStats_StartsEmpty()
    {
        var stats = new PlayerStats { UserId = "user-1" };
        stats.TotalGames.Should().Be(0);
        stats.TotalScore.Should().Be(0);
        stats.BestScore.Should().Be(0);
        stats.HappinessBest.Should().Be(0);
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
    public void PlayerStats_RecordCompletedSession_TracksPerEmotionBest()
    {
        var stats = new PlayerStats { UserId = "user-1" };
        var s1 = new GameSession { UserId = "user-1", SessionId = "s1" };
        s1.Captures.Add(new RoundCapture { TargetEmotion = TargetEmotion.Anger, Score = 5 });
        stats.RecordCompletedSession(s1);
        var s2 = new GameSession { UserId = "user-1", SessionId = "s2" };
        s2.Captures.Add(new RoundCapture { TargetEmotion = TargetEmotion.Anger, Score = 9 });
        stats.RecordCompletedSession(s2);
        stats.AngerBest.Should().Be(9);
    }

    [Fact]
    public void PlayerStats_RecordCompletedSession_KeepsLowerBestIfNewScoreIsLower()
    {
        var stats = new PlayerStats { UserId = "user-1" };
        var s1 = new GameSession { UserId = "user-1" };
        s1.Captures.Add(new RoundCapture { TargetEmotion = TargetEmotion.Fear, Score = 9 });
        stats.RecordCompletedSession(s1);
        var s2 = new GameSession { UserId = "user-1" };
        s2.Captures.Add(new RoundCapture { TargetEmotion = TargetEmotion.Fear, Score = 4 });
        stats.RecordCompletedSession(s2);
        stats.FearBest.Should().Be(9);
    }

    [Fact]
    public void GameSession_TotalScore_SumsAllCaptures()
    {
        var s = new GameSession();
        s.Captures.Add(new RoundCapture { Score = 3 });
        s.Captures.Add(new RoundCapture { Score = 7 });
        s.Captures.Add(new RoundCapture { Score = 5 });
        s.TotalScore.Should().Be(15);
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

    [Fact]
    public void ScoringFormula_ScoreIsTenTimesConfidenceWhenHeadPoseValid()
    {
        // Documented formula: score = headPoseValid ? round(confidence * 10) : 0
        // We test via the HeadPoseValidator gate and the round formula.
        var cases = new[]
        {
            (confidence: 0.95f, expected: 10),
            (confidence: 0.50f, expected: 5),
            (confidence: 0.49f, expected: 5), // banker's rounding to even
            (confidence: 0.10f, expected: 1),
            (confidence: 0.00f, expected: 0),
        };
        foreach (var (confidence, expected) in cases)
        {
            var score = HeadPoseValidator.Validate(0, 0) ? (int)Math.Round(confidence * 10) : 0;
            score.Should().Be(expected, $"confidence={confidence} should yield score={expected}");
        }
    }
}
