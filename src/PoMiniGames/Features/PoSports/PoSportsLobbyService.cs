using System.Collections.Concurrent;
using PoShared.Games;

namespace PoMiniGames.Features.PoSports;

/// <summary>
/// Single global PoSports lobby, mirroring <see cref="PoRacer.PoRacerLobbyService"/>:
/// the first arrival becomes host, everyone picks a distinct character (first-come
/// lock), and when all non-host members are Ready the host starts the meet. When the
/// race ends or the lobby drains it resets so a new host can claim it.
/// </summary>
public sealed class PoSportsLobbyService
{
    /// <summary>Fixed code surfaced in <see cref="PoSportsLobbyState.GameCode"/>; no codes are user-visible.</summary>
    public const string GlobalCode = "LOBBY";

    /// <summary>Lanes on the track — and therefore the human cap per meet.</summary>
    public const int MaxPlayers = 4;

    private readonly ConcurrentDictionary<string, PoSportsLobbyMember> _members = new();
    private string _hostConnectionId = "";
    private long _startedAtMs;
    private readonly object _stateLock = new();

    public PoSportsLobbyState State
    {
        get
        {
            lock (_stateLock)
            {
                return new PoSportsLobbyState(
                    Members: _members.Values.OrderBy(m => m.ConnectionId).ToList(),
                    HostConnectionId: string.IsNullOrEmpty(_hostConnectionId) ? null : _hostConnectionId,
                    GameCode: GlobalCode,
                    Phase: _startedAtMs > 0 ? "starting" : "waiting",
                    LastUpdatedUtc: DateTimeOffset.UtcNow);
            }
        }
    }

    public IReadOnlyList<PoSportsLobbyMember> Members
    {
        get { lock (_stateLock) return _members.Values.OrderBy(m => m.ConnectionId).ToList(); }
    }

    public bool IsEmpty
    {
        get { lock (_stateLock) return _members.IsEmpty; }
    }

    /// <summary>Open the lobby. If empty, the caller becomes host; otherwise joins.</summary>
    public (PoSportsLobbyState state, string eventMessage) Open(string connectionId, string displayName, bool isGuest)
    {
        lock (_stateLock)
        {
            var name = SanitizeName(displayName);
            // Stale "race in progress" recovery, same rule as PoRacer: if a started
            // race outlived its safety cap with nobody left, clear the flag.
            if (_startedAtMs > 0 && (NowMs() - _startedAtMs) > 90_000 && _members.IsEmpty)
            {
                _startedAtMs = 0;
            }
            if (_startedAtMs > 0)
            {
                return (State, "Meet already in progress");
            }
            if (!_members.ContainsKey(connectionId) && _members.Count >= MaxPlayers)
            {
                return (State, "Lobby is full");
            }
            if (_members.TryRemove(connectionId, out _) && _hostConnectionId == connectionId)
            {
                _hostConnectionId = "";
            }
            _members[connectionId] = new PoSportsLobbyMember(connectionId, name, isGuest, "", false);
            if (string.IsNullOrEmpty(_hostConnectionId))
            {
                _hostConnectionId = connectionId;
            }
            return (State, $"{name} joined");
        }
    }

    /// <summary>
    /// Claim a character (first-come lock). Fails when the key is unknown or another
    /// member already holds it; re-picking your own character is a no-op success.
    /// </summary>
    public (bool ok, string message) PickCharacter(string connectionId, string character)
    {
        lock (_stateLock)
        {
            if (!_members.TryGetValue(connectionId, out var member)) return (false, "Not in lobby");
            if (!PoSportsConstants.Characters.Contains(character)) return (false, "Unknown character");
            var holder = _members.Values.FirstOrDefault(m => m.Character == character);
            if (holder is not null && holder.ConnectionId != connectionId)
            {
                return (false, $"{character} is taken");
            }
            _members[connectionId] = member with { Character = character };
            return (true, $"{member.DisplayName} picked {character}");
        }
    }

    public void SetReady(string connectionId, bool ready)
    {
        lock (_stateLock)
        {
            if (!_members.TryGetValue(connectionId, out var existing)) return;
            _members[connectionId] = existing with { IsReady = ready };
        }
    }

    public (bool ok, string message) Leave(string connectionId)
    {
        lock (_stateLock)
        {
            if (!_members.TryRemove(connectionId, out var removed)) return (true, "");
            if (_hostConnectionId == connectionId)
            {
                _hostConnectionId = _members.Keys.OrderBy(k => k, StringComparer.Ordinal).FirstOrDefault() ?? "";
            }
            if (_members.IsEmpty)
            {
                _startedAtMs = 0;
            }
            return (true, $"{removed.DisplayName} left");
        }
    }

    /// <summary>
    /// Host-only start. Requires every non-host member Ready and every member to have
    /// picked a character (the meet can't seed lanes without one).
    /// </summary>
    public bool TryStart(string connectionId)
    {
        lock (_stateLock)
        {
            if (_startedAtMs > 0) return false;
            if (_hostConnectionId != connectionId) return false;
            if (_members.IsEmpty) return false;
            if (_members.Values.Any(m => string.IsNullOrEmpty(m.Character))) return false;
            var notReady = _members.Values.Where(m => m.ConnectionId != _hostConnectionId && !m.IsReady).ToList();
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
            foreach (var key in _members.Keys.ToList())
            {
                if (_members.TryGetValue(key, out var m))
                {
                    _members[key] = m with { IsReady = false };
                }
            }
        }
    }

    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static string SanitizeName(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "Player";
        var trimmed = raw.Trim();
        return trimmed.Length > 24 ? trimmed[..24] : trimmed;
    }
}
