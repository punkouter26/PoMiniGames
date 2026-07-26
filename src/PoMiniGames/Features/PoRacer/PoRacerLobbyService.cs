using System.Collections.Concurrent;
using PoShared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// Single global PoRacer lobby. The first arrival becomes the host; subsequent
/// arrivals join as players. When everyone is Ready and the host clicks Start,
/// the race spins up on <see cref="PoRacerRaceService"/>. When the race ends
/// (or everyone leaves) the lobby resets to empty so a new host can claim it.
/// </summary>
public sealed class PoRacerLobbyService
{
    /// <summary>Fixed code surfaced in <see cref="PoRacerLobbyState.GameCode"/>; no codes are user-visible.</summary>
    public const string GlobalCode = "LOBBY";

    private readonly ConcurrentDictionary<string, PoRacerLobbyPlayer> _players = new();
    private string _hostConnectionId = "";
    private long _startedAtMs;
    private long _lastTouchedMs;
    private readonly object _stateLock = new();

    public PoRacerLobbyState State
    {
        get
        {
            lock (_stateLock)
            {
                return new PoRacerLobbyState(
                    Players: _players.Values.OrderBy(p => p.ConnectionId).ToList(),
                    HostConnectionId: string.IsNullOrEmpty(_hostConnectionId) ? null : _hostConnectionId,
                    GameCode: GlobalCode,
                    LastUpdatedUtc: DateTimeOffset.UtcNow);
            }
        }
    }

    public IReadOnlyList<PoRacerLobbyPlayer> Players
    {
        get { lock (_stateLock) return _players.Values.OrderBy(p => p.ConnectionId).ToList(); }
    }

    public string? HostConnectionId
    {
        get { lock (_stateLock) return string.IsNullOrEmpty(_hostConnectionId) ? null : _hostConnectionId; }
    }

    public bool IsStarted => _startedAtMs > 0;

    /// <summary>Open the lobby. If empty, the caller becomes host; otherwise joins.</summary>
    public (PoRacerLobbyState state, string eventMessage) Open(string connectionId, string displayName, bool isGuest)
    {
        lock (_stateLock)
        {
            var name = SanitizeName(displayName);
            // §2026-07-18: stale "race in progress" recovery. If the lobby has
            // been in a "started" state for longer than the 90s race safety
            // cap and the dict is empty (i.e. every player dropped mid-race),
            // accept the new join and clear the flag — the prior race never
            // produced an EndRace() because the only client left before the
            // race sim hit AllFinishedOrStopped().
            if (_startedAtMs > 0 && (NowMs() - _startedAtMs) > 90_000 && _players.IsEmpty)
            {
                _startedAtMs = 0;
            }
            if (_startedAtMs > 0)
            {
                return (State, "Race already in progress");
            }
            if (_players.TryRemove(connectionId, out _) && _hostConnectionId == connectionId)
            {
                _hostConnectionId = "";
            }
            _players[connectionId] = new PoRacerLobbyPlayer(connectionId, name, isGuest, false);
            if (string.IsNullOrEmpty(_hostConnectionId))
            {
                _hostConnectionId = connectionId;
            }
            _lastTouchedMs = NowMs();
            return (State, $"{name} joined");
        }
    }

    public void SetReady(string connectionId, bool ready)
    {
        lock (_stateLock)
        {
            if (!_players.TryGetValue(connectionId, out var existing)) return;
            _players[connectionId] = existing with { IsReady = ready };
            _lastTouchedMs = NowMs();
        }
    }

    /// <summary>
    /// Flip the caller's ready flag under the state lock and report the state that was
    /// actually stored. Callers must announce THIS value: a read-then-SetReady pair
    /// outside the lock races two rapid toggles and broadcasts the pre-toggle state.
    /// </summary>
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
            // §2026-07-18: when the lobby drains, reset _startedAtMs so the next
            // visitor isn't locked out by a stale "race in progress" flag. This
            // happens when a client joins, kicks off a race, then disconnects
            // before the race sim ticks its 90s safety cap (e.g. the lobby→race
            // navigation glitch where the client never actually reached
            // JoinRace, so the race sim never reached AllFinishedOrStopped).
            if (_players.IsEmpty)
            {
                _startedAtMs = 0;
            }
            _lastTouchedMs = NowMs();
            return (true, $"{removed.DisplayName} left");
        }
    }

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

    public void EndRace()
    {
        lock (_stateLock)
        {
            _startedAtMs = 0;
            // Reset ready flags so the next race needs a fresh Ready round.
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
