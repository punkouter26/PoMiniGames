using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Integration;

/// <summary>
/// PoSports score round-trip against a real Azurite container (via
/// <see cref="TestWebApplicationFactory"/>): save → get returns it, the per-player
/// ratchet rejects slower meets and accepts faster ones, and validation rejects
/// malformed submissions at the HTTP boundary.
/// </summary>
public sealed class PoSportsHighScoreTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    public PoSportsHighScoreTests(TestWebApplicationFactory factory) => _factory = factory;

    private static PoSportsHighScore Meet(string player, double sprint, double hurdles, string character = "kim") => new()
    {
        PlayerName = player,
        SprintSeconds = sprint,
        HurdlesSeconds = hurdles,
        TotalTimeSeconds = sprint + hurdles,
        Character = character,
        Date = "2026-07-21T12:00:00Z",
    };

    [Fact]
    public async Task SaveGetAndRatchet_RoundTrip()
    {
        if (!_factory.DockerAvailable) return;
        // §2 CSRF: every POST below is a state-changing /api/* call and is refused
        // without the synchroniser token.
        var client = await _factory.CreateClient().ArmAntiforgeryAsync();

        // Save → get returns the row.
        var post = await client.PostAsJsonAsync("/api/posports/highscores", Meet("Ratchet Runner", 14.2, 21.3));
        post.StatusCode.Should().Be(HttpStatusCode.Created);

        var board = await client.GetFromJsonAsync<List<PoSportsHighScore>>("/api/posports/highscores");
        var row = board!.Single(s => s.PlayerName == "Ratchet Runner");
        row.TotalTimeSeconds.Should().BeApproximately(35.5, 0.001);

        // A slower meet must NOT overwrite the PB…
        (await client.PostAsJsonAsync("/api/posports/highscores", Meet("Ratchet Runner", 20.0, 25.0)))
            .StatusCode.Should().Be(HttpStatusCode.Created);
        board = await client.GetFromJsonAsync<List<PoSportsHighScore>>("/api/posports/highscores");
        board!.Single(s => s.PlayerName == "Ratchet Runner").TotalTimeSeconds.Should().BeApproximately(35.5, 0.001);

        // …and a faster one must.
        (await client.PostAsJsonAsync("/api/posports/highscores", Meet("Ratchet Runner", 12.0, 19.0)))
            .StatusCode.Should().Be(HttpStatusCode.Created);
        board = await client.GetFromJsonAsync<List<PoSportsHighScore>>("/api/posports/highscores");
        var rows = board!.Where(s => s.PlayerName == "Ratchet Runner").ToList();
        rows.Should().HaveCount(1, "the descriptor keys one row per player");
        rows[0].TotalTimeSeconds.Should().BeApproximately(31.0, 0.001);
    }

    [Fact]
    public async Task Post_RejectsMalformedSubmissions()
    {
        if (!_factory.DockerAvailable) return;
        // Armed so these assertions still exercise the *validation* rejection (400) rather than
        // collapsing into a blanket antiforgery 403 that would pass for the wrong reason.
        var client = await _factory.CreateClient().ArmAntiforgeryAsync();

        // Legs that don't sum to the total.
        var mismatched = Meet("Cheater", 10, 20);
        mismatched.TotalTimeSeconds = 25;
        (await client.PostAsJsonAsync("/api/posports/highscores", mismatched))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // Unknown character.
        (await client.PostAsJsonAsync("/api/posports/highscores", Meet("Modder", 10, 20, character: "gizmo")))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // Name too long.
        (await client.PostAsJsonAsync("/api/posports/highscores", Meet(new string('x', 40), 10, 20)))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
