using System.Collections.Concurrent;
using System.Text.Json;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Features.Multiplayer;

internal sealed class MultiplayerService : IMultiplayerService, IDisposable
{
    private static readonly TimeSpan MatchLifetime = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan CleanupInterval = TimeSpan.FromMinutes(5);

    /// <summary>Protects queue-scan operations that create or search across all matches.</summary>
    private readonly object _queueLock = new();
    private readonly ConcurrentDictionary<string, MutableMultiplayerMatch> _matches = new(StringComparer.Ordinal);
    private readonly IMultiplayerGameRegistry _gameRegistry;
    private readonly Timer _cleanupTimer;

    public MultiplayerService(IMultiplayerGameRegistry gameRegistry)
    {
        _gameRegistry = gameRegistry;
        _cleanupTimer = new Timer(_ => CleanupExpiredMatches(), null, CleanupInterval, CleanupInterval);
    }

    public IReadOnlyCollection<SupportedMultiplayerGame> GetSupportedGames() =>
        _gameRegistry.GetSupportedGames();

    public MultiplayerMatchSnapshot JoinQueue(string gameKey, AuthenticatedUser user)
    {
        if (!_gameRegistry.TryGetAdapter(gameKey, out var adapter) || adapter is null)
        {
            throw new InvalidOperationException($"Unsupported multiplayer game '{gameKey}'.");
        }

        lock (_queueLock)
        {
            var existing = _matches.Values.FirstOrDefault(match =>
                string.Equals(match.GameKey, adapter.GameKey, StringComparison.OrdinalIgnoreCase)
                && match.Status is MultiplayerMatchStatus.WaitingForOpponent or MultiplayerMatchStatus.InProgress
                && match.ContainsUser(user.UserId));

            if (existing is not null)
            {
                existing.ConnectedUserIds.Add(user.UserId);
                existing.UpdatedAt = DateTimeOffset.UtcNow;
                return CreateSnapshot(existing);
            }

            var waitingMatch = _matches.Values
                .Where(match => string.Equals(match.GameKey, adapter.GameKey, StringComparison.OrdinalIgnoreCase)
                    && match.Status == MultiplayerMatchStatus.WaitingForOpponent
                    && match.PlayerTwo is null
                    && !match.ContainsUser(user.UserId))
                .OrderBy(match => match.CreatedAt)
                .FirstOrDefault();

            if (waitingMatch is not null)
            {
                waitingMatch.PlayerTwo = user;
                waitingMatch.Status = MultiplayerMatchStatus.InProgress;
                waitingMatch.State = adapter.CreateInitialState(waitingMatch);
                waitingMatch.CurrentTurnUserId = adapter.Mode == MultiplayerTransportMode.TurnBased
                    ? waitingMatch.PlayerOne.UserId
                    : null;
                waitingMatch.ConnectedUserIds.Add(user.UserId);
                waitingMatch.UpdatedAt = DateTimeOffset.UtcNow;
                return CreateSnapshot(waitingMatch);
            }

            var createdAt = DateTimeOffset.UtcNow;
            var match = new MutableMultiplayerMatch
            {
                MatchId = Guid.NewGuid().ToString("N"),
                GameKey = adapter.GameKey,
                DisplayName = adapter.DisplayName,
                Mode = adapter.Mode,
                PlayerOne = user,
                Status = MultiplayerMatchStatus.WaitingForOpponent,
                CreatedAt = createdAt,
                UpdatedAt = createdAt,
            };

            match.ConnectedUserIds.Add(user.UserId);
            _matches[match.MatchId] = match;
            return CreateSnapshot(match);
        }
    }

    public MultiplayerMatchSnapshot? GetMatch(string matchId, AuthenticatedUser user)
    {
        if (!_matches.TryGetValue(matchId, out var match) || !match.ContainsUser(user.UserId))
            return null;

        lock (match.Lock)
        {
            return match.ContainsUser(user.UserId) ? CreateSnapshot(match) : null;
        }
    }

    public MultiplayerMatchSnapshot? LeaveMatch(string matchId, AuthenticatedUser user)
    {
        if (!_matches.TryGetValue(matchId, out var match) || !match.ContainsUser(user.UserId))
            return null;

        lock (match.Lock)
        {
            if (!match.ContainsUser(user.UserId))
                return null;

            match.Status = MultiplayerMatchStatus.Abandoned;
            match.WinnerUserId = ResolveOtherUserId(match, user.UserId);
            match.CurrentTurnUserId = null;
            match.Result = match.WinnerUserId is null
                ? $"{user.DisplayName} left the queue."
                : $"{user.DisplayName} left the match.";
            match.UpdatedAt = DateTimeOffset.UtcNow;
            match.ConnectedUserIds.Remove(user.UserId);

            return CreateSnapshot(match);
        }
    }

    public MultiplayerActionResult SubmitTurn(string matchId, AuthenticatedUser user, JsonElement action)
    {
        if (!_matches.TryGetValue(matchId, out var match) || !match.ContainsUser(user.UserId))
            return new MultiplayerActionResult(false, "Match not found.", null, true);

        lock (match.Lock)
        {
            if (!match.ContainsUser(user.UserId))
                return new MultiplayerActionResult(false, "Match not found.", null, true);

            if (match.Status != MultiplayerMatchStatus.InProgress)
            {
                return new MultiplayerActionResult(false, "The match is not active.", CreateSnapshot(match));
            }

            if (!_gameRegistry.TryGetAdapter(match.GameKey, out var adapter) || adapter is null)
            {
                return new MultiplayerActionResult(false, "Game adapter is unavailable.", CreateSnapshot(match));
            }

            if (adapter.Mode != MultiplayerTransportMode.TurnBased)
            {
                return new MultiplayerActionResult(false, "Use realtime input relay for this game.", CreateSnapshot(match));
            }

            var result = adapter.ApplyTurn(match, user, action.Clone());
            if (!result.Accepted)
            {
                return new MultiplayerActionResult(false, result.Error, CreateSnapshot(match));
            }

            match.State = result.State;
            match.CurrentTurnUserId = result.NextTurnUserId;
            match.Status = result.Status;
            match.WinnerUserId = result.WinnerUserId;
            match.Result = result.Result;
            match.UpdatedAt = DateTimeOffset.UtcNow;

            return new MultiplayerActionResult(true, null, CreateSnapshot(match));
        }
    }

    public IReadOnlyCollection<MultiplayerMatchSnapshot> SetPresence(AuthenticatedUser user, bool connected)
    {
        var changedMatches = new List<MultiplayerMatchSnapshot>();
        foreach (var match in _matches.Values.Where(match => match.ContainsUser(user.UserId)))
        {
            lock (match.Lock)
            {
                if (!match.ContainsUser(user.UserId))
                    continue;

                if (connected)
                {
                    match.ConnectedUserIds.Add(user.UserId);
                }
                else
                {
                    match.ConnectedUserIds.Remove(user.UserId);

                    if (match.Status == MultiplayerMatchStatus.WaitingForOpponent
                        && string.Equals(match.PlayerOne.UserId, user.UserId, StringComparison.Ordinal))
                    {
                        _matches.TryRemove(match.MatchId, out _);
                        continue;
                    }
                }

                match.UpdatedAt = DateTimeOffset.UtcNow;
                changedMatches.Add(CreateSnapshot(match));
            }
        }

        return changedMatches;
    }

    public RealtimeRelayEnvelope? BuildRealtimeEnvelope(string matchId, AuthenticatedUser user, JsonElement payload)
    {
        if (!_matches.TryGetValue(matchId, out var match)
            || !match.ContainsUser(user.UserId))
            return null;

        lock (match.Lock)
        {
            if (!match.ContainsUser(user.UserId)
                || match.Status != MultiplayerMatchStatus.InProgress
                || match.Mode != MultiplayerTransportMode.Realtime)
            {
                return null;
            }

            if (match.State is RealtimeRelayState state)
            {
                match.State = state with { Sequence = state.Sequence + 1 };
            }

            match.UpdatedAt = DateTimeOffset.UtcNow;

            var recipients = match.GetPlayers()
                .Where(player => !string.Equals(player.UserId, user.UserId, StringComparison.Ordinal))
                .Select(player => player.UserId)
                .ToArray();

            return new RealtimeRelayEnvelope(matchId, user.UserId, user.DisplayName, payload.Clone(), recipients);
        }
    }

    public IReadOnlyCollection<MultiplayerMatchSnapshot> GetActiveMatches()
    {
        // ConcurrentDictionary snapshot is safe to iterate without an explicit lock.
        return _matches.Values
            .Where(m => m.Status == MultiplayerMatchStatus.InProgress)
            .Select(CreateSnapshot)
            .ToList();
    }

    private void CleanupExpiredMatches()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var match in _matches.Values.Where(match => now - match.UpdatedAt > MatchLifetime))
        {
            _matches.TryRemove(match.MatchId, out _);
        }
    }

    private MultiplayerMatchSnapshot CreateSnapshot(MutableMultiplayerMatch match)
    {
        var participants = new List<MultiplayerParticipant>
        {
            new(match.PlayerOne.UserId, match.PlayerOne.DisplayName, 1, match.ConnectedUserIds.Contains(match.PlayerOne.UserId)),
        };

        if (match.PlayerTwo is not null)
        {
            participants.Add(new MultiplayerParticipant(
                match.PlayerTwo.UserId,
                match.PlayerTwo.DisplayName,
                2,
                match.ConnectedUserIds.Contains(match.PlayerTwo.UserId)));
        }

        return new MultiplayerMatchSnapshot(
            match.MatchId,
            match.GameKey,
            match.DisplayName,
            match.Mode,
            match.Status,
            participants.ToArray(),
            match.CurrentTurnUserId,
            match.WinnerUserId,
            match.Result,
            match.State,
            match.CreatedAt,
            match.UpdatedAt);
    }

    private static string? ResolveOtherUserId(MutableMultiplayerMatch match, string actorUserId)
    {
        if (!string.Equals(match.PlayerOne.UserId, actorUserId, StringComparison.Ordinal))
        {
            return match.PlayerOne.UserId;
        }

        return match.PlayerTwo?.UserId;
    }

    public void Dispose()
    {
        _cleanupTimer.Dispose();
    }
}
