using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using FluentAssertions;
using PoMiniGames.Features.Multiplayer;

namespace PoMiniGames.IntegrationTests;

public class MultiplayerEndpointsTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    // Server serializes enums as strings (JsonStringEnumConverter in Program.cs).
    // Use matching options here so ReadFromJsonAsync can parse them correctly.
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

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

        var waitingSnapshot = await firstResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>(JsonOptions);
        var activeSnapshot = await secondResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>(JsonOptions);

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
        var waitingSnapshot = await waitingResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>(JsonOptions);
        var activeSnapshot = await activeResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>(JsonOptions);

        waitingSnapshot.Should().NotBeNull();
        activeSnapshot.Should().NotBeNull();

        var matchId = waitingSnapshot!.MatchId;
        var turnResponse = await playerOne.PostAsJsonAsync($"/api/multiplayer/matches/{matchId}/turn", new MatchActionRequest(JsonDocument.Parse("{\"action\":{\"column\":0}}")
            .RootElement
            .GetProperty("action")));

        turnResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var updatedSnapshot = await turnResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>(JsonOptions);

        updatedSnapshot.Should().NotBeNull();
        updatedSnapshot!.CurrentTurnUserId.Should().Be("user-two");
        updatedSnapshot.Status.Should().Be(MultiplayerMatchStatus.InProgress);
        updatedSnapshot.State.Should().BeOfType<JsonElement>();

        var state = (JsonElement)updatedSnapshot.State;
        var board = state.GetProperty("board");
        board[8][0].GetInt32().Should().Be(1);
    }

    [Fact]
    public async Task SubmitTurn_TicTacToe_UpdatesBoardAndPassesTurnToOpponent()
    {
        var playerX = CreateClient("ttt-x-user", "PlayerX");
        var playerO = CreateClient("ttt-o-user", "PlayerO");

        var waitingResponse = await playerX.PostAsJsonAsync("/api/multiplayer/queue", new QueueMatchRequest("tictactoe"));
        var activeResponse = await playerO.PostAsJsonAsync("/api/multiplayer/queue", new QueueMatchRequest("tictactoe"));

        var waitingSnapshot = await waitingResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>(JsonOptions);
        var activeSnapshot = await activeResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>(JsonOptions);

        waitingSnapshot.Should().NotBeNull();
        activeSnapshot.Should().NotBeNull();
        activeSnapshot!.Status.Should().Be(MultiplayerMatchStatus.InProgress);
        // PlayerOne (the first to queue) is always assigned the X seat.
        activeSnapshot.CurrentTurnUserId.Should().Be("ttt-x-user");

        var matchId = waitingSnapshot!.MatchId;
        var turnResponse = await playerX.PostAsJsonAsync(
            $"/api/multiplayer/matches/{matchId}/turn",
            new MatchActionRequest(JsonDocument.Parse("{\"action\":{\"row\":2,\"col\":3}}").RootElement.GetProperty("action")));

        turnResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var updatedSnapshot = await turnResponse.Content.ReadFromJsonAsync<MultiplayerMatchSnapshot>(JsonOptions);

        updatedSnapshot.Should().NotBeNull();
        updatedSnapshot!.Status.Should().Be(MultiplayerMatchStatus.InProgress);
        updatedSnapshot.CurrentTurnUserId.Should().Be("ttt-o-user");

        var state = (JsonElement)updatedSnapshot.State!;
        var board = state.GetProperty("board");
        // X piece = 1; placed at row 2, col 3.
        board[2][3].GetInt32().Should().Be(1);
    }

    [Fact]
    public async Task QueueResponse_MatchStatus_IsSerializedAsString()
    {
        // ── Contract test: React client compares match.status against string
        // literals ('InProgress', 'WaitingForOpponent', …). If the server ever
        // reverts to integer enum serialization this test will catch it. ──────
        var playerA = CreateClient("enum-a-user", "EnumA");
        var playerB = CreateClient("enum-b-user", "EnumB");

        var waitingResponse = await playerA.PostAsJsonAsync("/api/multiplayer/queue", new QueueMatchRequest("tictactoe"));
        waitingResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        var waitingJson = await waitingResponse.Content.ReadAsStringAsync();
        using var waitingDoc = JsonDocument.Parse(waitingJson);
        var waitingStatus = waitingDoc.RootElement.GetProperty("status");
        waitingStatus.ValueKind.Should().Be(JsonValueKind.String,
            because: "MultiplayerMatchStatus must be serialized as a string so React client comparisons work");
        waitingStatus.GetString().Should().Be("WaitingForOpponent");

        var activeResponse = await playerB.PostAsJsonAsync("/api/multiplayer/queue", new QueueMatchRequest("tictactoe"));
        activeResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        var activeJson = await activeResponse.Content.ReadAsStringAsync();
        using var activeDoc = JsonDocument.Parse(activeJson);
        var activeStatus = activeDoc.RootElement.GetProperty("status");
        activeStatus.ValueKind.Should().Be(JsonValueKind.String,
            because: "Matched InProgress snapshot status must also be a string");
        activeStatus.GetString().Should().Be("InProgress");
    }

    private HttpClient CreateClient(string userId, string displayName)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserIdHeader, userId);
        client.DefaultRequestHeaders.Add(TestAuthHandler.DisplayNameHeader, displayName);
        return client;
    }
}