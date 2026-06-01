namespace PoMiniGamesClient.Models;

/// <summary>
/// A single tap attempt in a PoClick session.
/// </summary>
public record PoClickAttempt(
    int BeatIndex,
    double TargetTimeMs,
    double ActualTimeMs,
    double OffsetMs,
    string Rating
);

/// <summary>
/// Completed PoClick session with drummer analytics, stored locally.
/// </summary>
public class PoClickSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string PlayerName { get; set; } = "";
    public int Bpm { get; set; }
    public int DurationSeconds { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public List<PoClickAttempt> Attempts { get; set; } = new();

    // Basic counts
    public int PerfectCount { get; set; }
    public int GoodCount { get; set; }
    public int OkayCount { get; set; }
    public int MissCount { get; set; }
    public int MaxStreak { get; set; }
    public double Score { get; set; }

    // ── Analytics (ported from PoClick GameSession.cs) ──

    public double GetAverageOffsetMs()
    {
        if (!Attempts.Any()) return 0;
        return Attempts.Average(a => Math.Abs(a.OffsetMs));
    }

    public double GetStandardDeviationMs()
    {
        if (Attempts.Count < 2) return 0;
        double avg = Attempts.Average(a => a.OffsetMs);
        double sumOfSquares = Attempts.Sum(a => Math.Pow(a.OffsetMs - avg, 2));
        return Math.Sqrt(sumOfSquares / (Attempts.Count - 1));
    }

    /// <summary>Pocket Rating based on timing standard deviation.</summary>
    public string GetPocketRating()
    {
        double stdDev = GetStandardDeviationMs();
        return stdDev switch
        {
            <= 15 => "Elite",
            <= 30 => "Pro",
            <= 50 => "Solid",
            <= 80 => "Drifting",
            _ => "Unsteady"
        };
    }

    /// <summary>% of non-miss taps that were early (rushing the beat).</summary>
    public double GetRushPercent()
    {
        var nonMiss = Attempts.Where(a => a.Rating != "Miss" && a.BeatIndex >= 0).ToList();
        if (!nonMiss.Any()) return 0;
        return Math.Round((double)nonMiss.Count(a => a.OffsetMs < 0) / nonMiss.Count * 100, 1);
    }

    /// <summary>% of non-miss taps that were late (dragging the beat).</summary>
    public double GetDragPercent()
    {
        var nonMiss = Attempts.Where(a => a.Rating != "Miss" && a.BeatIndex >= 0).ToList();
        if (!nonMiss.Any()) return 0;
        return Math.Round((double)nonMiss.Count(a => a.OffsetMs > 0) / nonMiss.Count * 100, 1);
    }

    /// <summary>Linear regression slope of offset vs beat index. Positive = drifting later over time.</summary>
    public double GetDriftTrendSlope()
    {
        var valid = Attempts.Where(a => a.BeatIndex >= 0 && a.Rating != "Miss").ToList();
        if (valid.Count < 3) return 0;
        double n = valid.Count;
        double sumX = valid.Sum(a => (double)a.BeatIndex);
        double sumY = valid.Sum(a => a.OffsetMs);
        double sumXY = valid.Sum(a => a.BeatIndex * a.OffsetMs);
        double sumX2 = valid.Sum(a => (double)a.BeatIndex * a.BeatIndex);
        double denom = n * sumX2 - sumX * sumX;
        if (Math.Abs(denom) < 0.001) return 0;
        return Math.Round((n * sumXY - sumX * sumY) / denom, 3);
    }

    /// <summary>Normalized 0-100 score: 100 = machine-perfect, lower = more erratic.</summary>
    public double GetConsistencyScore()
    {
        double stdDev = GetStandardDeviationMs();
        return Math.Round(Math.Max(0, Math.Min(100, 100 - stdDev)), 1);
    }

    /// <summary>For longer sessions: avg error difference between first and second half. Positive = fatigue.</summary>
    public double GetFatigueDelta()
    {
        var valid = Attempts.Where(a => a.BeatIndex >= 0 && a.Rating != "Miss").ToList();
        if (valid.Count < 4) return 0;
        int half = valid.Count / 2;
        double firstHalf = valid.Take(half).Average(a => Math.Abs(a.OffsetMs));
        double secondHalf = valid.Skip(half).Average(a => Math.Abs(a.OffsetMs));
        return Math.Round(secondHalf - firstHalf, 1);
    }

    /// <summary>% of scheduled beats that hit the Perfect zone.</summary>
    public double GetZonePercent()
    {
        var scorable = Attempts.Where(a => a.BeatIndex >= 0).ToList();
        if (!scorable.Any()) return 0;
        return Math.Round((double)scorable.Count(a => a.Rating == "Perfect") / scorable.Count * 100, 1);
    }

    /// <summary>Count of taps fired between beats (ghost notes).</summary>
    public int GetGhostTapCount() => Attempts.Count(a => a.BeatIndex == -1);

    /// <summary>Coefficient of variation: (stdDev / beatIntervalMs) × 100. Tempo-normalized consistency.</summary>
    public double GetTempoStabilityCoefficient()
    {
        if (Bpm <= 0) return 0;
        double beatIntervalMs = 60000.0 / Bpm;
        double stdDev = GetStandardDeviationMs();
        return Math.Round(stdDev / beatIntervalMs * 100, 2);
    }

    /// <summary>Worst single tap deviation (ms) — outlier detection.</summary>
    public double GetPeakDeviationMs()
    {
        var valid = Attempts.Where(a => a.BeatIndex >= 0 && a.Rating != "Miss").ToList();
        if (!valid.Any()) return 0;
        return Math.Round(valid.Max(a => Math.Abs(a.OffsetMs)), 1);
    }

    /// <summary>Normalized 0-100 overall score from domain logic.</summary>
    public double CalculateOverallScore()
    {
        if (!Attempts.Any()) return 0;

        double baseScore = Attempts.Sum(a => a.Rating switch
        {
            "Perfect" => 100.0,
            "Good" => 75.0,
            "Okay" => 40.0,
            _ => 0.0
        }) / Attempts.Count;

        double stdDev = GetStandardDeviationMs();
        double penalty = Math.Min(30, stdDev * 0.3);
        double finalScore = Math.Max(0, baseScore - penalty);

        return Math.Round(finalScore, 1);
    }
}