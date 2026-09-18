// filepath: tests/PoMiniGames.E2EUI/StubJevClient.cs
using PoMiniGames.AI;

namespace PoMiniGames.E2EUI;

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
}
