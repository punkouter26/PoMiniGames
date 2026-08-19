using System.Collections.Concurrent;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// Single global PoVoxelStrike lobby for co-op survival (up to <see cref="MaxPlayers"/>.
/// <para>The lobby is the entrance point, not the game — the wired Brain-contract is
/// "press one button, land in the room" (matches PoFunQuiz 2026-08-10 retirement of
/// "create a game / join by code"). The first arrival becomes host; subsequent
/// arrivals join as players until the cap is reached. When everyone is Ready and the
/// host clicks Start, the lockstep runtime takes over.</para>
///
/// <para>The lockstep runtime (<see cref="PoVoxelStrikeLockstepService"/>) is owned by
/// the lobby service: when the host calls Start, the lobby allocates a session and
/// the lockstep hub takes over the SignalR group until the run ends.</para>
/// </summary>
public sealed class PoVoxelStrikeLobbyService
{
    /// <summary>Fixed code surfaced in <see cref="PoVoxelStrikeLobbyState.GameCode"/>; no codes are user-visible.</summary>
    public const string GlobalCode = "VOXELL";

    /// <summary>Per the proposal: 2–4 default, up to 6 supported. The F1 host can sustain 6; above that the desync detector mis-fires under load.</summary>
    public const int MaxPlayers = 6;

    private readonly ConcurrentDictionary<string, PoVoxelStrikeLobbyPlayer> _players = new();
    private string _hostConnectionId = "";
    private long _startedAtMs;
    private long _lastTouchedMs;
    private readonly object _stateLock = new();

    public PoVoxelStrikeLobbyState State
    {
        get
        {
            lock (_stateLock)
            {
                return new PoVoxelStrikeLobbyState(
                    Players: _players.Values.OrderBy(p => p.ConnectionId).ToList(),
                    HostConnectionId: string.IsNullOrEmpty(_hostConnectionId) ? null : _hostConnectionId,
                    GameCode: GlobalCode,
                    MaxPlayers: MaxPlayers,
                    LastUpdatedUtc: DateTimeOffset.UtcNow);
            }
        }
    }

    public IReadOnlyList<PoVoxelStrikeLobbyPlayer> Players
    {
        get { lock (_stateLock) return _players.Values.OrderBy(p => p.ConnectionId).ToList(); }
    }

    public string? HostConnectionId
    {
        get { lock (_stateLock) return string.IsNullOrEmpty(_hostConnectionId) ? null : _hostConnectionId; }
    }

    public bool IsStarted => _startedAtMs > 0;

    /// <summary>Open the lobby. If empty, the caller becomes host; otherwise joins. Refuses joins when full or started.</summary>
    public (PoVoxelStrikeLobbyState state, string eventMessage) Open(string connectionId, string displayName, bool isGuest)
    {
        lock (_stateLock)
        {
            // Stale "run in progress" recovery: if a session has been "started" longer than the
            // 90s safety cap and the dict is empty, clear the flag — the prior run never
            // produced an EndRun() because every player dropped before the cap fired.
            if (_startedAtMs > 0 && (NowMs() - _startedAtMs) > 90_000 && _players.IsEmpty)
            {
                _startedAtMs = 0;
            }
            if (_startedAtMs > 0)
            {
                return (State, "Run already in progress");
            }
            if (_players.Count >= MaxPlayers && !_players.ContainsKey(connectionId))
            {
                return (State, "Lobby is full");
            }
            if (_players.TryRemove(connectionId, out _) && _hostConnectionId == connectionId)
            {
                _hostConnectionId = "";
            }
            // Stable seat assignment: count current players (excluding the rejoiner) so a
            // re-join keeps its prior seat — that stabilizes PlayerNumber-based RowKey guards.
            var seat = _players.Count == 0
                ? 1
                : _players.Values.Where(p => p.ConnectionId != connectionId).Select(p => p.PlayerNumber).DefaultIfEmpty(0).Max() + 1;
            var name = SanitizeName(displayName);
            _players[connectionId] = new PoVoxelStrikeLobbyPlayer(connectionId, name, isGuest, false, seat);
            if (string.IsNullOrEmpty(_hostConnectionId))
            {
                _hostConnectionId = connectionId;
            }
            _lastTouchedMs = NowMs();
            return (State, $"{name} joined");
        }
    }

    public (bool ok, bool isReady, string message) ToggleReady(string connectionId)
    {
        lock (_stateLock)
        {
            if (!_players.TryGetValue(connectionId, out var existing)) return (false, false, "");
            var toggled = existing with { IsReady = !existing.IsReady };
            _players[connectionId] = toggled;
            _lastTouchedMs = NowMs();
            return (true, toggled.IsReady, $"{toggled.DisplayName} is {(toggled.IsReady ? "ready" : "not ready")}");
        }
    }

    public (bool ok, string message) Leave(string connectionId)
    {
        lock (_stateLock)
        {
            if (!_players.TryRemove(connectionId, out var removed)) return (true, "");
            if (_hostConnectionId == connectionId)
            {
                _hostConnectionId = _players.Keys.OrderBy(k => k, StringComparer.Ordinal).FirstOrDefault() ?? "";
            }
            if (_players.IsEmpty)
            {
                _startedAtMs = 0;
            }
            _lastTouchedMs = NowMs();
            return (true, $"{removed.DisplayName} left");
        }
    }

    /// <summary>
    /// Try to start a run. Only the host can start; everyone else must be ready; at least
    /// 1 player must be in the lobby (the host). On success, marks the lobby as started
    /// so subsequent joins are rejected until the lockstep hub calls <see cref="EndRun"/>.
    /// </summary>
    public bool TryStart(string connectionId)
    {
        lock (_stateLock)
        {
            if (_startedAtMs > 0) return false;
            if (_hostConnectionId != connectionId) return false;
            if (_players.IsEmpty) return false;
            var notReady = _players.Values.Where(p => p.ConnectionId != _hostConnectionId && !p.IsReady).ToList();
            if (notReady.Count > 0) return false;
            _startedAtMs = NowMs();
            return true;
        }
    }

    public void EndRun()
    {
        lock (_stateLock)
        {
            _startedAtMs = 0;
            // Reset ready flags so the next run needs a fresh Ready round.
            foreach (var key in _players.Keys.ToList())
            {
                if (_players.TryGetValue(key, out var p))
                {
                    _players[key] = p with { IsReady = false };
                }
            }
            _lastTouchedMs = NowMs();
        }
    }

    public bool IsEmpty
    {
        get { lock (_stateLock) return _players.IsEmpty; }
    }

    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static string SanitizeName(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "Player";
        var trimmed = raw.Trim();
        return trimmed.Length > 24 ? trimmed[..24] : trimmed;
    }
}
