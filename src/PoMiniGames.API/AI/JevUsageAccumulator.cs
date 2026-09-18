// filepath: src/PoMiniGames.API/AI/JevUsageAccumulator.cs
using System.Collections.Concurrent;

namespace PoMiniGames.AI;

/// <summary>
/// Process-local read-model of every Jev decision this host has made. Process-local
/// and not authoritative — the durable truth is the per-call log lines; this answers
/// "what is Jev doing right now on this host" without a query.
///
/// <para>
/// <b>Decision trace.</b> <see cref="JevCallRecord.Decision"/> carries the calibrated
/// outcome the caller branched on (a noul probability, a chosen option, or a rubric
/// score) plus the confidence Jev reported. That is what makes the
/// <c>/api/health/jev</c> endpoint useful for debugging gates: you can see why a
/// particular joke was rated "not worth a chat call" or which option PoEcosystem
/// picked for a tech transition.
/// </para>
/// </summary>
public sealed class JevUsageAccumulator
{
    private readonly ConcurrentQueue<JevCallRecord> _recent = new();
    private readonly ConcurrentDictionary<string, JevUsageBucket> _byGame = new(StringComparer.OrdinalIgnoreCase);
    private const int RecentCapacity = 50;

    public void Record(string game, string questionType, JevCallOutcome outcome, double confidence, string? chosenOption, long latencyMs, bool failingThrough, long inputTokens = 0)
    {
        // §Jev pricing: Jev on OpenRouter is $0.042 / M input tokens, $0 output. The host
        // bills itself with list prices from DeploymentPricing.Catalog so the per-game
        // cost row in /api/health/jev matches what OpenRouter would charge. Failures and
        // bypasses price at zero — they never reached the model.
        var cost = failingThrough || inputTokens <= 0
            ? 0d
            : DeploymentPricing.For("typesafe/jev-1.13").CostUsd(inputTokens, 0);

        _recent.Enqueue(new JevCallRecord(
            Game: game,
            QuestionType: questionType,
            Decision: new JevDecisionView(outcome, confidence, chosenOption),
            LatencyMs: latencyMs,
            FailingThrough: failingThrough,
            CostUsd: cost,
            RecordedAtUtc: DateTimeOffset.UtcNow));

        while (_recent.Count > RecentCapacity && _recent.TryDequeue(out _)) { }

        var bucket = _byGame.GetOrAdd(game, static _ => new JevUsageBucket());
        lock (bucket.SyncRoot)
        {
            bucket.Calls++;
            if (failingThrough) bucket.Failures++;
            else bucket.SuccessfulDecisions++;
            bucket.TotalLatencyMs += latencyMs;
            bucket.MaxLatencyMs = Math.Max(bucket.MaxLatencyMs, latencyMs);
            bucket.TotalCostUsd += cost;
            bucket.RecentQuestionTypes[questionType] = bucket.RecentQuestionTypes.GetValueOrDefault(questionType) + 1;
            bucket.RecentChosenOptions[chosenOption ?? "(none)"] = bucket.RecentChosenOptions.GetValueOrDefault(chosenOption ?? "(none)") + 1;
        }
    }

    public JevUsageReportDto Snapshot()
    {
        var perGame = _byGame
            .OrderBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase)
            .Select(kv =>
            {
                var b = kv.Value;
                var avg = b.Calls == 0 ? 0d : b.TotalLatencyMs / (double)b.Calls;
                return new JevGameUsageDto(
                    Game: kv.Key,
                    Calls: b.Calls,
                    Failures: b.Failures,
                    SuccessfulDecisions: b.SuccessfulDecisions,
                    AverageLatencyMs: avg,
                    MaxLatencyMs: b.MaxLatencyMs,
                    TotalCostUsd: b.TotalCostUsd,
                    AverageCostUsd: b.Calls == 0 ? 0d : b.TotalCostUsd / b.Calls,
                    QuestionTypes: new Dictionary<string, long>(b.RecentQuestionTypes),
                    ChosenOptions: new Dictionary<string, long>(b.RecentChosenOptions));
            })
            .ToList();

        var recent = _recent
            .TakeLast(RecentCapacity)
            .Select(r => new JevCallRecordDto(
                Game: r.Game,
                QuestionType: r.QuestionType,
                Outcome: r.Decision.Outcome.ToString(),
                Confidence: r.Decision.Confidence,
                ChosenOption: r.Decision.ChosenOption,
                LatencyMs: r.LatencyMs,
                FailingThrough: r.FailingThrough,
                CostUsd: r.CostUsd,
                RecordedAtUtc: r.RecordedAtUtc))
            .ToList();

        return new JevUsageReportDto(
            Calls: perGame.Sum(g => g.Calls),
            Failures: perGame.Sum(g => g.Failures),
            SuccessfulDecisions: perGame.Sum(g => g.SuccessfulDecisions),
            AverageLatencyMs: perGame.Count == 0 ? 0d : perGame.Average(g => g.AverageLatencyMs),
            TotalCostUsd: perGame.Sum(g => g.TotalCostUsd),
            Games: perGame,
            RecentCalls: recent);
    }

    private sealed class JevUsageBucket
    {
        public readonly object SyncRoot = new();
        public long Calls;
        public long Failures;
        public long SuccessfulDecisions;
        public long TotalLatencyMs;
        public long MaxLatencyMs;
        public double TotalCostUsd;
        public readonly Dictionary<string, long> RecentQuestionTypes = new(StringComparer.OrdinalIgnoreCase);
        public readonly Dictionary<string, long> RecentChosenOptions = new(StringComparer.OrdinalIgnoreCase);
    }

    private readonly record struct JevCallRecord(string Game, string QuestionType, JevDecisionView Decision, long LatencyMs, bool FailingThrough, double CostUsd, DateTimeOffset RecordedAtUtc);
    private readonly record struct JevDecisionView(JevCallOutcome Outcome, double Confidence, string? ChosenOption);
}

/// <summary>Outcome classification that lands on <see cref="JevCallRecordDto.Outcome"/>.</summary>
public enum JevCallOutcome
{
    /// <summary>Jev answered noul with a probability.</summary>
    Noul,
    /// <summary>Jev picked one option from the declared criteria.</summary>
    Choice,
    /// <summary>Jev returned a score in the rubric.</summary>
    Score,
}

public sealed record JevGameUsageDto(
    string Game,
    long Calls,
    long Failures,
    long SuccessfulDecisions,
    double AverageLatencyMs,
    long MaxLatencyMs,
    double TotalCostUsd,
    double AverageCostUsd,
    IReadOnlyDictionary<string, long> QuestionTypes,
    IReadOnlyDictionary<string, long> ChosenOptions);

public sealed record JevCallRecordDto(
    string Game,
    string QuestionType,
    string Outcome,
    double Confidence,
    string? ChosenOption,
    long LatencyMs,
    bool FailingThrough,
    double CostUsd,
    DateTimeOffset RecordedAtUtc);

public sealed record JevUsageReportDto(
    long Calls,
    long Failures,
    long SuccessfulDecisions,
    double AverageLatencyMs,
    double TotalCostUsd,
    IReadOnlyList<JevGameUsageDto> Games,
    IReadOnlyList<JevCallRecordDto> RecentCalls);
