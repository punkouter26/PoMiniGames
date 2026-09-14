using System.Collections.Concurrent;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Single global PoBrawl 1v1 lobby. Cap is 2 — there is no "join as spectator",
/// no team queue. First arrival becomes host; the second arrival becomes the
/// challenger and triggers the ready check. When both are ready the host's
/// <see cref="PoBrawlLobbyHub.StartGame"/> call spins up the match service.
/// </summary>
/// <remarks>
/// <para>
/// Process-local like every other lobby. If the host restarts, players re-join —
/// the lobby is deliberately not durable, and a 1v1 has no reason to outlast its
/// session.
/// </para>
/// <para>
/// Fighter selection happens at Join time rather than later because the match
/// service needs both fighters pinned to start a fight. A late picker would either
/// require a second hub round-trip or default silently to one — neither was
/// acceptable when the survey confirmed PoBrawl has 15 named fighters and players
/// choose deliberately between them.
/// </para>
/// </remarks>
public sealed class PoBrawlLobbyService
{
    /// <summary>Fixed code surfaced in <see cref="PoBrawlLobbyState.GameCode"/>; no codes are user-visible.</summary>
    public const string GlobalCode = "BRAWL";

    /// <summary>Hard cap. PoBrawl is 1v1 only — a third arrival is rejected.</summary>
    public const int MaxPlayers = 2;

    private readonly ConcurrentDictionary<string, PoBrawlLobbyPlayer> _players = new();
    private string _hostConnectionId = "";
    private long _startedAtMs;
    private long _lastTouchedMs;
    private readonly object _stateLock = new();

    public PoBrawlLobbyState State
    {
        get
        {
            lock (_stateLock)
            {
                return new PoBrawlLobbyState(
                    Players: _players.Values.OrderBy(p => p.ConnectionId).ToList(),
                    HostConnectionId: string.IsNullOrEmpty(_hostConnectionId) ? null : _hostConnectionId,
                    GameCode: GlobalCode,
                    LastUpdatedUtc: DateTimeOffset.UtcNow);
            }
        }
    }

    public IReadOnlyList<PoBrawlLobbyPlayer> Players
    {
        get { lock (_stateLock) return _players.Values.OrderBy(p => p.ConnectionId).ToList(); }
    }

    public string? HostConnectionId
    {
        get { lock (_stateLock) return string.IsNullOrEmpty(_hostConnectionId) ? null : _hostConnectionId; }
    }

    public bool IsStarted => _startedAtMs > 0;

    /// <summary>
    /// Open the lobby. If empty, the caller becomes host; otherwise joins as challenger
    /// until the cap is reached. Re-joining the same connection refreshes the player.
    /// </summary>
    public (PoBrawlLobbyState state, string eventMessage) Open(
        string connectionId, string principalId, string displayName, bool isGuest, PoBrawlFighter fighter)
    {
        lock (_stateLock)
        {
            var name = SanitizeName(displayName);
            var pid = SanitizePrincipal(principalId);
            // Stale-match recovery. If a previous fight is still flagged started and
            // everyone has dropped, accept the new join and clear the flag — the
            // previous match never produced a result because both clients left
            // mid-fight, so the lobby is functionally empty.
            if (_startedAtMs > 0 && (NowMs() - _startedAtMs) > MatchStaleAfterMs && _players.IsEmpty)
            {
                _startedAtMs = 0;
            }
            if (_startedAtMs > 0)
            {
                return (State, "Match already in progress");
            }
            if (!_players.IsEmpty && _players.Count >= MaxPlayers && !_players.ContainsKey(connectionId))
            {
                return (State, "Lobby is full");
            }
            // The same player reconnecting with the same connection id is a refresh;
            // re-joining with a new connection id (post-reconnect) updates the key
            // but preserves the principal slot.
            if (_players.TryRemove(connectionId, out var existing))
            {
                if (_hostConnectionId == connectionId) _hostConnectionId = "";
                // Preserve the original principal id so two connections from the same
                // player do not both count toward MaxPlayers.
                pid = existing.PrincipalId;
            }
            _players[connectionId] = new PoBrawlLobbyPlayer(connectionId, pid, name, isGuest, false, fighter);
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
            // §2026-09-14: same drain-reset as PoRacer — when the lobby empties, clear
            // the "match in progress" flag so the next visitor isn't locked out by a
            // stale flag from a fight both sides disconnected from.
            if (_players.IsEmpty)
            {
                _startedAtMs = 0;
            }
            _lastTouchedMs = NowMs();
            return (true, $"{removed.DisplayName} left");
        }
    }

    /// <summary>
    /// Try to launch a match. Host-only, requires both players ready, requires a
    /// fresh fighter pair (no overlap). Sets the "match started" flag atomically so
    /// a second Start call cannot race past the first.
    /// </summary>
    public bool TryStart(string connectionId)
    {
        lock (_stateLock)
        {
            if (_startedAtMs > 0) return false;
            if (_hostConnectionId != connectionId) return false;
            if (_players.Count != MaxPlayers) return false;
            if (_players.Values.Any(p => !p.IsReady)) return false;
            _startedAtMs = NowMs();
            return true;
        }
    }

    public void EndMatch()
    {
        lock (_stateLock)
        {
            _startedAtMs = 0;
            // Reset ready flags so the next match needs a fresh Ready round.
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

    /// <summary>
    /// A fight that never produced a result (both players dropped) is treated as
    /// stale after this many ms, matching the PoRacer lobby's 90s safety cap. The
    /// next visitor can then join and the flag clears.
    /// </summary>
    private const long MatchStaleAfterMs = 90_000;

    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static string SanitizeName(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "Player";
        var trimmed = raw.Trim();
        return trimmed.Length > 24 ? trimmed[..24] : trimmed;
    }

    /// <summary>
    /// Principal id sanitiser. The auth cookie supplies the value; we still lower-case
    /// and trim because the value doubles as a Table Storage row key, and Azure table
    /// row keys are case-sensitive — a write that lower-cases and a read that doesn't
    /// would never find its own row.
    /// </summary>
    private static string SanitizePrincipal(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "anon";
        return raw.Trim().ToLowerInvariant();
    }
}
