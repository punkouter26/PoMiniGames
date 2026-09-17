using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.PoCabinet;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.Integration.Features.PoCabinet;

/// <summary>
/// PoCabinet score round-trip against a real Azurite container through the full HTTP
/// path. Three claims:
/// <list type="number">
///   <item>A best lap submitted on <c>capitol</c> survives a fresh
///         <c>GET /api/pocabinet/scores?track=capitol</c> on the same host. Cross-Azurite
///         session round-trip — the row lives in the table the descriptor declared.</item>
///   <item>Track partitioning is real: the same player on Capitol and Mar-a-Lago
///         gets two distinct rows; a Capitol submission does not appear in the
///         Mar-a-Lago board.</item>
///   <item>ETag-update overwrite is ratcheting: a worse later lap does not erase a
///         better PB, and a faster lap does.</item>
/// </list>
/// <para>
/// <b>Test identity.</b> <see cref="TestWebApplicationFactory"/> signs every
/// request as <c>test-user</c> via the FakeAuth scheme, and the server
/// overwrites the wire-supplied <c>PlayerDisplayName</c> with the resolved
/// identity. The assertions match on that resolved name (<c>"test-user"</c>),
/// not the randomized wire name — the wire name is the issue PoRacer had to
/// fix for the same reason (see PoRacerScoreEndpoints.cs header comment).
/// </para>
/// One method, three claims. The Integration tier is at its 50 cap (per
/// <see cref="IntegrationTestCountCeilingTests"/>) and the rule is to consolidate
/// rather than raise.
/// </summary>
public sealed class PoCabinetScoreStorageTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    public PoCabinetScoreStorageTests(TestWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task SubmitAndReadRoundTrips_TrackPartitionsHold_AndOverwriteIsRatcheting()
    {
        if (!_factory.DockerAvailable) return;
        // §2 CSRF: the POSTs below are state-changing /api/* calls and are refused without
        // the synchroniser token. Arm up front so the ratcheting assertions at the end
        // exercise a real 200 rather than collapsing into a blanket 403.
        var client = await _factory.CreateClient().ArmAntiforgeryAsync();

        // The server resolves identity from FakeAuth → "test-user". Randomise the wire
        // player name so a stale row from a prior run cannot match by accident; the
        // asserted identity is the resolved one.
        const string resolvedPlayer = "test-user";
        var wirePlayer = $"pocabinet-int-{Guid.NewGuid():N}";
        var submit = new PoCabinetScoreDto
        {
            PlayerDisplayName = wirePlayer,
            TrackId = "capitol",
            BestLapSeconds = 42.0,
            FinalPosition = 1,
            AchievedAtUtc = DateTimeOffset.UtcNow,
            IsGuest = true,
            GameCode = "INT-TEST",
        };

        // ── Submit a Capitol best lap ─────────────────────────────────────
        var firstPost = await client.PostAsJsonAsync("/api/pocabinet/scores", submit);
        firstPost.StatusCode.Should().Be(HttpStatusCode.Created);

        var capitolBoard = await client.GetFromJsonAsync<List<PoCabinetHighScore>>(
            "/api/pocabinet/scores?track=capitol");
        capitolBoard.Should().NotBeNull();
        capitolBoard!.Should().Contain(s => s.PlayerName == resolvedPlayer && Math.Abs(s.BestLapSeconds - 42.0) < 0.001,
            "the server resolves identity from auth, not the wire PlayerDisplayName (anti-spoofing)");

        // ── Submit a Mar-a-Lago best lap for the same player (no partition leak) ─
        submit.TrackId = "maralago";
        submit.BestLapSeconds = 55.0;
        submit.FinalPosition = 2;
        var secondPost = await client.PostAsJsonAsync("/api/pocabinet/scores", submit);
        secondPost.StatusCode.Should().Be(HttpStatusCode.Created);

        var marBoard = await client.GetFromJsonAsync<List<PoCabinetHighScore>>(
            "/api/pocabinet/scores?track=maralago");
        marBoard.Should().NotBeNull();
        marBoard!.Should().Contain(s => s.PlayerName == resolvedPlayer && Math.Abs(s.BestLapSeconds - 55.0) < 0.001);
        marBoard.Should().NotContain(s => Math.Abs(s.BestLapSeconds - 42.0) < 0.001,
            "the Capitol 42.0 must not appear on the Mar-a-Lago board");

        // ── A worse later Capitol lap must NOT overwrite the PB ────────────
        submit.TrackId = "capitol";
        submit.BestLapSeconds = 99.0;
        submit.FinalPosition = 4;
        var worsePost = await client.PostAsJsonAsync("/api/pocabinet/scores", submit);
        worsePost.StatusCode.Should().Be(HttpStatusCode.Created);
        var capitolBoardAfter = await client.GetFromJsonAsync<List<PoCabinetHighScore>>(
            "/api/pocabinet/scores?track=capitol");
        capitolBoardAfter!.First(s => s.PlayerName == resolvedPlayer).BestLapSeconds
            .Should().BeApproximately(42.0, 0.001, "a worse lap must not erase a stored PB");

        // ── A faster Capitol lap overwrites the PB ─────────────────────────
        submit.BestLapSeconds = 38.5;
        submit.FinalPosition = 1;
        var fasterPost = await client.PostAsJsonAsync("/api/pocabinet/scores", submit);
        fasterPost.StatusCode.Should().Be(HttpStatusCode.Created);
        var capitolBoardFinal = await client.GetFromJsonAsync<List<PoCabinetHighScore>>(
            "/api/pocabinet/scores?track=capitol");
        capitolBoardFinal!.First(s => s.PlayerName == resolvedPlayer).BestLapSeconds
            .Should().BeApproximately(38.5, 0.001, "a faster lap must replace the stored PB");
    }
}