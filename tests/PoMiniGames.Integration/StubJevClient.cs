// filepath: tests/PoMiniGames.Integration/StubJevClient.cs
using PoMiniGames.AI;

namespace PoMiniGames.Integration;

/// <summary>
/// In-process <see cref="IJevClient"/> stub for the Integration + E2E-API
/// fixtures. Bypasses by default so the gates stay transparent; gate-specific
/// tests can resolve this stub directly and override <see cref="RespondNoul"/>
/// to exercise the skip / pass branches.
///
/// <para>
/// <b>Drift warning.</b> Tests/Shared/TestBudgetGuard.cs is the single source
/// of truth for AI mocking. Jev deliberately lives beside each fixture because
/// <see cref="IJevClient"/> is an API-side type — pulling it into the shared
/// library would force a ProjectReference on the API, which the shared lib
/// avoids by design. Adding a new AI boundary means editing BOTH
/// <see cref="TestBudgetGuard.Overrides"/> AND the fixture-level Replace.
/// </para>
/// </summary>
public sealed class StubJevClient : IJevClient
{
    public Func<string, object?, JevDecision<double>?>? RespondNoul { get; set; }
    public Func<string, IReadOnlyDictionary<string, string>?, object?, JevDecision<string>?>? RespondChoice { get; set; }
    public Func<string, IReadOnlyDictionary<string, string>?, object?, JevDecision<double>?>? RespondScore { get; set; }

    public int Calls { get; private set; }

    public Task<JevDecision<double>> EvaluateNoulAsync(string instructions, object state, CancellationToken ct = default)
    {
        Calls++;
        var r = RespondNoul?.Invoke(instructions, state);
        return Task.FromResult(r ?? JevDecision<double>.Bypass());
    }

    public Task<JevDecision<string>> EvaluateChoiceAsync(string instructions, IReadOnlyDictionary<string, string> criteria, object state, CancellationToken ct = default)
    {
        Calls++;
        var r = RespondChoice?.Invoke(instructions, criteria, state);
        return Task.FromResult(r ?? JevDecision<string>.Bypass());
    }

    public Task<JevDecision<double>> EvaluateScoreAsync(string instructions, IReadOnlyDictionary<string, string> levels, object state, CancellationToken ct = default)
    {
        Calls++;
        var r = RespondScore?.Invoke(instructions, levels, state);
        return Task.FromResult(r ?? JevDecision<double>.Bypass());
    }

    public static JevDecision<double> Skip(double noul = 0.1, double confidence = 0.95) => new(noul, confidence, false);
    public static JevDecision<double> Pass(double noul = 0.95, double confidence = 0.95) => new(noul, confidence, false);
}
