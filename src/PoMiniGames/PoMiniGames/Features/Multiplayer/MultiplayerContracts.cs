using System.Text.Json;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Features.Multiplayer;

public enum MultiplayerMatchStatus
{
    WaitingForOpponent,
    InProgress,
    Completed,
    Abandoned,
}

public enum MultiplayerTransportMode
{
    TurnBased,
    Realtime,
}

public sealed record QueueMatchRequest(string GameKey);

public sealed record MatchActionRequest(JsonElement Action);

public sealed record MultiplayerParticipant(string UserId, string DisplayName, int Seat, bool IsConnected);

public sealed record MultiplayerMatchSnapshot(
    string MatchId,
    string GameKey,
    string DisplayName,
    MultiplayerTransportMode Mode,
    MultiplayerMatchStatus Status,
    MultiplayerParticipant[] Participants,
    string? CurrentTurnUserId,
    string? WinnerUserId,
    string? Result,
    object? State,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

public sealed record MultiplayerActionResult(bool Accepted, string? Error, MultiplayerMatchSnapshot? Snapshot, bool NotFound = false);

public sealed record SupportedMultiplayerGame(string GameKey, string DisplayName, MultiplayerTransportMode Mode, bool EnabledForQueue);

public sealed record TicTacToeMultiplayerState(int[][] Board, string XUserId, string OUserId, int MoveCount);

public sealed record ConnectFiveMultiplayerState(int[][] Board, string RedUserId, string YellowUserId, int MoveCount);

public sealed record RealtimeRelayState(string Phase, long Sequence);

internal interface IMultiplayerGameRegistry
{
    IReadOnlyCollection<SupportedMultiplayerGame> GetSupportedGames();

    bool TryGetAdapter(string gameKey, out IMultiplayerGameAdapter? adapter);
}

public interface IMultiplayerService
{
    MultiplayerMatchSnapshot JoinQueue(string gameKey, AuthenticatedUser user);

    IReadOnlyCollection<SupportedMultiplayerGame> GetSupportedGames();

    MultiplayerMatchSnapshot? GetMatch(string matchId, AuthenticatedUser user);

    MultiplayerMatchSnapshot? LeaveMatch(string matchId, AuthenticatedUser user);

    MultiplayerActionResult SubmitTurn(string matchId, AuthenticatedUser user, JsonElement action);

    IReadOnlyCollection<MultiplayerMatchSnapshot> SetPresence(AuthenticatedUser user, bool connected);

    RealtimeRelayEnvelope? BuildRealtimeEnvelope(string matchId, AuthenticatedUser user, JsonElement payload);
}

internal interface IMultiplayerGameAdapter
{
    string GameKey { get; }

    string DisplayName { get; }

    MultiplayerTransportMode Mode { get; }

    object CreateInitialState(MutableMultiplayerMatch match);

    GameTurnResult ApplyTurn(MutableMultiplayerMatch match, AuthenticatedUser actor, JsonElement action);
}

internal sealed class MutableMultiplayerMatch
{
    public required string MatchId { get; init; }

    public required string GameKey { get; init; }

    public required string DisplayName { get; init; }

    public required MultiplayerTransportMode Mode { get; init; }

    public required AuthenticatedUser PlayerOne { get; init; }

    public AuthenticatedUser? PlayerTwo { get; set; }

    public MultiplayerMatchStatus Status { get; set; }

    public string? CurrentTurnUserId { get; set; }

    public string? WinnerUserId { get; set; }

    public string? Result { get; set; }

    public object? State { get; set; }

    public HashSet<string> ConnectedUserIds { get; } = new(StringComparer.Ordinal);

    public DateTimeOffset CreatedAt { get; init; }

    public DateTimeOffset UpdatedAt { get; set; }

    public bool ContainsUser(string userId) =>
        string.Equals(PlayerOne.UserId, userId, StringComparison.Ordinal)
        || string.Equals(PlayerTwo?.UserId, userId, StringComparison.Ordinal);

    public IReadOnlyList<AuthenticatedUser> GetPlayers() =>
        PlayerTwo is null ? [PlayerOne] : [PlayerOne, PlayerTwo];
}

internal sealed record GameTurnResult(
    bool Accepted,
    string? Error,
    object? State,
    string? NextTurnUserId,
    MultiplayerMatchStatus Status,
    string? WinnerUserId,
    string? Result);

public sealed record RealtimeRelayEnvelope(
    string MatchId,
    string FromUserId,
    string FromDisplayName,
    JsonElement Payload,
    string[] RecipientUserIds);
