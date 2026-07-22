using System.Text.RegularExpressions;
using FluentAssertions;
using PoMiniGames.Features.PoSports;

namespace PoMiniGames.Unit.Features.PoSports;

/// <summary>
/// The stride model is implemented twice — PoSportsSim.cs (server-authoritative online
/// races) and physics.js (local 1P/2P/demo, which must work offline). This test parses
/// the CONSTANTS block out of physics.js and pins it to PoSportsConstants, so the two
/// implementations cannot drift without failing the build.
/// </summary>
public sealed class PoSportsConstantsSyncTests
{
    private static readonly Dictionary<string, double> JsConstants = ParsePhysicsJs();

    private static Dictionary<string, double> ParsePhysicsJs()
    {
        // Walk up from the test bin dir to the repo root (global.json lives there).
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "global.json")))
        {
            dir = dir.Parent;
        }
        dir.Should().NotBeNull("the repo root (global.json) must be reachable from the test bin dir");

        var path = Path.Combine(dir!.FullName,
            "src", "PoMiniGames.Client", "wwwroot", "js", "posports", "physics.js");
        File.Exists(path).Should().BeTrue($"physics.js must exist at {path}");

        var source = File.ReadAllText(path);
        var block = Regex.Match(source, @"export const CONSTANTS = \{(?<body>[^}]*)\}",
            RegexOptions.Singleline);
        block.Success.Should().BeTrue("physics.js must export a CONSTANTS object literal");

        return Regex.Matches(block.Groups["body"].Value, @"(?<name>[A-Z_]+):\s*(?<value>[\d.e/-]+)")
            .ToDictionary(
                m => m.Groups["name"].Value,
                m => double.Parse(m.Groups["value"].Value, System.Globalization.CultureInfo.InvariantCulture));
    }

    public static TheoryData<string, double> Pairs => new()
    {
        { "IMPULSE", PoSportsConstants.Impulse },
        { "DECAY", PoSportsConstants.Decay },
        { "MAX_SPEED", PoSportsConstants.MaxSpeed },
        { "JUMP_DURATION", PoSportsConstants.JumpDuration },
        { "JUMP_DRAG", PoSportsConstants.JumpDrag },
        { "STUMBLE_FACTOR", PoSportsConstants.StumbleFactor },
        { "STUMBLE_PENALTY", PoSportsConstants.StumblePenalty },
        { "FALSE_START_HOLD", PoSportsConstants.FalseStartHold },
        { "SPRINT_LENGTH", PoSportsConstants.SprintLength },
        { "HURDLES_LENGTH", PoSportsConstants.HurdlesLength },
        { "INTERSTITIAL_SECONDS", PoSportsConstants.InterstitialSeconds },
        { "TICK", PoSportsConstants.Tick },
    };

    [Theory]
    [MemberData(nameof(Pairs))]
    public void JsConstant_MatchesCSharp(string jsName, double csharpValue)
    {
        JsConstants.Should().ContainKey(jsName,
            "every C# constant must appear in physics.js's CONSTANTS block");
        JsConstants[jsName].Should().BeApproximately(csharpValue, 1e-12,
            $"physics.js {jsName} and PoSportsConstants must change in the same commit");
    }

    [Fact]
    public void HurdlePositions_Match()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "global.json"))) dir = dir.Parent;
        var source = File.ReadAllText(Path.Combine(dir!.FullName,
            "src", "PoMiniGames.Client", "wwwroot", "js", "posports", "physics.js"));

        var m = Regex.Match(source, @"export const HURDLE_POSITIONS = \[(?<body>[^\]]*)\]");
        m.Success.Should().BeTrue();
        var js = m.Groups["body"].Value.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(double.Parse).ToArray();

        js.Should().Equal(PoSportsConstants.HurdlePositions);
    }
}
