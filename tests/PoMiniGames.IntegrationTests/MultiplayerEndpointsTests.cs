using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using PoMiniGames.Features.Multiplayer;

namespace PoMiniGames.IntegrationTests;

public class MultiplayerEndpointsTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    public MultiplayerEndpointsTests(TestWebApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task JoinQueue_TwoPlayers_StartsTurnBasedMatch()
    {
        var playerOne = CreateClient("user-one", "Alice");
        var playerTwo = CreateClient("user-two", "Bob");

        var firstResponse = await playerOne.PostAsJsonAsync("/api/multiplayer/queue", new QueueMatchRequest("tictactoe"));
        var secondResponse = await playerTwo.PostAsJsonAsync("/api/multiplayer/queue", new QueueMatchRequest("tictactoe"));

        firstResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        secondResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        var waitingSnapshot = await firstResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>();
        var activeSnapshot = await secondResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>();

        waitingSnapshot.Should().NotBeNull();
        activeSnapshot.Should().NotBeNull();
        waitingSnapshot!.Status.Should().Be(MultiplayerMatchStatus.WaitingForOpponent);
        activeSnapshot!.Status.Should().Be(MultiplayerMatchStatus.InProgress);
        activeSnapshot.Participants.Should().HaveCount(2);
        activeSnapshot.CurrentTurnUserId.Should().Be("user-one");
    }

    [Fact]
    public async Task SubmitTurn_UpdatesBoardAndHandsTurnToOpponent()
    {
        var playerOne = CreateClient("user-one", "Alice");
        var playerTwo = CreateClient("user-two", "Bob");

        var waitingResponse = await playerOne.PostAsJsonAsync("/api/multiplayer/queue", new QueueMatchRequest("connectfive"));
        var activeResponse = await playerTwo.PostAsJsonAsync("/api/multiplayer/queue", new QueueMatchRequest("connectfive"));
        var waitingSnapshot = await waitingResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>();
        var activeSnapshot = await activeResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>();

        waitingSnapshot.Should().NotBeNull();
        activeSnapshot.Should().NotBeNull();

        var matchId = waitingSnapshot!.MatchId;
        var turnResponse = await playerOne.PostAsJsonAsync($"/api/multiplayer/matches/{matchId}/turn", new MatchActionRequest(JsonDocument.Parse("{\"action\":{\"column\":0}}")
            .RootElement
            .GetProperty("action")));

        turnResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var updatedSnapshot = await turnResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>();

        updatedSnapshot.Should().NotBeNull();
        updatedSnapshot!.CurrentTurnUserId.Should().Be("user-two");
        updatedSnapshot.Status.Should().Be(MultiplayerMatchStatus.InProgress);
        updatedSnapshot.State.Should().BeOfType<JsonElement>();

        var state = (JsonElement)updatedSnapshot.State;
        var board = state.GetProperty("board");
        board[8][0].GetInt32().Should().Be(1);
    }

    private HttpClient CreateClient(string userId, string displayName)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserIdHeader, userId);
        client.DefaultRequestHeaders.Add(TestAuthHandler.DisplayNameHeader, displayName);
        return client;
    }
}