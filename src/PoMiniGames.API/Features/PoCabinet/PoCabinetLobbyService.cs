using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// In-memory lobby state for a single PoCabinet race. Mirrors the shape of
/// <c>PoRacerLobbyService</c> — one lobby per game code, max 8 seats, host-only
/// start — but is single-purpose: PoCabinet ships no 1v1 mode, so the service
/// just tracks who's joined, who's ready, and whether the host has begun the
/// race. Race snapshots flow through <see cref="PoCabinetRaceHub"/>.
/// </summary>
public sealed class PoCabinetLobbyService
{
    private const int MaxPlayers = PoCabinetCatalog.CarCount;
    private static readonly char[] JoinCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray();

    private readonly Dictionary<string, Lobby> _byCode = new(StringComparer.OrdinalIgnoreCase);
    private readonly Random _rng = new();

    /// <summary>Open a lobby hosted by <paramref name="hostConnectionId"/>. Returns the join code.</summary>
    public string Open(string hostConnectionId, string displayName, bool isGuest, string? trackId)
    {
        var code = GenerateJoinCode();
        var lobby = new Lobby(
            code,
            hostConnectionId,
            displayName,
            isGuest,
            trackId ?? PoCabinetCatalog.DefaultTrackId);
        _byCode[code] = lobby;
        return code;
    }

    /// <summary>Join an existing lobby, or null if the code is unknown or the lobby is full.</summary>
    public Lobby? Join(string joinCode, string connectionId, string displayName, bool isGuest)
    {
        if (!_byCode.TryGetValue(joinCode, out var lobby)) return null;
        if (lobby.IsStarted) return null;
        if (lobby.Players.Count >= MaxPlayers) return null;
        if (lobby.Players.Any(p => p.ConnectionId == connectionId)) return lobby; // idempotent rejoin

        lobby.Players.Add(new LobbyPlayer(connectionId, displayName, isGuest, isReady: false));
        return lobby;
    }

    /// <summary>Toggle the player's ready flag.</summary>
    public bool ToggleReady(string joinCode, string connectionId)
    {
        if (!_byCode.TryGetValue(joinCode, out var lobby)) return false;
        var player = lobby.Players.FirstOrDefault(p => p.ConnectionId == connectionId);
        if (player is null) return false;
        player.IsReady = !player.IsReady;
        return true;
    }

    /// <summary>True if the host can begin the race (all players ready, ≥ 2 players).</summary>
    public bool CanStart(string joinCode, string hostConnectionId)
    {
        if (!_byCode.TryGetValue(joinCode, out var lobby)) return false;
        if (lobby.HostConnectionId != hostConnectionId) return false;
        if (lobby.Players.Count < 2) return false;
        return lobby.Players.All(p => p.IsReady);
    }

    /// <summary>Mark the lobby started and return the lobby snapshot for the race hub.</summary>
    public Lobby? Start(string joinCode, string hostConnectionId)
    {
        if (!_byCode.TryGetValue(joinCode, out var lobby)) return null;
        if (lobby.IsStarted) return null; // idempotent: a started lobby cannot re-enter Start
        if (!CanStart(joinCode, hostConnectionId)) return null;
        lobby.IsStarted = true;
        return lobby;
    }

    /// <summary>Remove a player; close the lobby when the last one leaves.</summary>
    public void Leave(string joinCode, string connectionId)
    {
        if (!_byCode.TryGetValue(joinCode, out var lobby)) return;
        lobby.Players.RemoveAll(p => p.ConnectionId == connectionId);
        if (lobby.Players.Count == 0)
        {
            _byCode.Remove(joinCode);
            return;
        }
        // If the host left, promote the first remaining player.
        if (lobby.HostConnectionId == connectionId)
        {
            var newHost = lobby.Players[0];
            lobby.HostConnectionId = newHost.ConnectionId;
            lobby.HostDisplayName = newHost.DisplayName;
        }
    }

    public Lobby? GetByCode(string joinCode) =>
        _byCode.TryGetValue(joinCode, out var lobby) ? lobby : null;

    private string GenerateJoinCode()
    {
        // 8-char alphanumeric (Crockford-style, no I/O/0/1 to avoid misread). Bounded
        // retry; 32^8 ≈ 1 trillion, collision is effectively zero in a real session.
        Span<char> buf = stackalloc char[8];
        for (int attempt = 0; attempt < 8; attempt++)
        {
            for (int i = 0; i < 8; i++)
                buf[i] = JoinCodeAlphabet[_rng.Next(JoinCodeAlphabet.Length)];
            var code = "CAB-" + new string(buf);
            if (!_byCode.ContainsKey(code)) return code;
        }
        // Fall back to a GUID-suffixed code; should never reach here in practice.
        return "CAB-" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();
    }

    public sealed class Lobby
    {
        public Lobby(string code, string hostConnectionId, string hostDisplayName, bool isGuest, string trackId)
        {
            Code = code;
            HostConnectionId = hostConnectionId;
            HostDisplayName = hostDisplayName;
            TrackId = trackId;
            Players = new List<LobbyPlayer>
            {
                new(hostConnectionId, hostDisplayName, isGuest, isReady: true), // host auto-readies
            };
        }

        public string Code { get; }
        public string HostConnectionId { get; set; }
        public string HostDisplayName { get; set; }
        public string TrackId { get; }
        public bool IsStarted { get; set; }
        public List<LobbyPlayer> Players { get; }
    }

    public sealed class LobbyPlayer
    {
        public LobbyPlayer(string connectionId, string displayName, bool isGuest, bool isReady)
        {
            ConnectionId = connectionId;
            DisplayName = displayName;
            IsGuest = isGuest;
            IsReady = isReady;
        }
        public string ConnectionId { get; }
        public string DisplayName { get; }
        public bool IsGuest { get; }
        public bool IsReady { get; set; }
    }
}
