using System.Security.Cryptography;
using System.Text;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// In-memory PoCabinet lobbies: one per join code, up to eight human seats, host-only start,
/// optional AI officials filling the free seats. A lobby outlives its race — when the race
/// ends it reopens with the same code and roster, which is what "rematch" means.
///
/// <para>
/// Seats are keyed by the caller's claim id, not the SignalR connection id. A reconnect gets a
/// new connection id; keying seats on it (as this class did until 2026-09-23) turned every
/// network blip into a lost seat. Connection ids are still tracked per player so a player is
/// only dropped once their LAST connection goes.
/// </para>
/// <para>
/// All state sits behind one lock: hub calls arrive on arbitrary threads and the race
/// registry's timer calls <see cref="MarkRaceFinished"/> from its own.
/// </para>
/// </summary>
public sealed class PoCabinetLobbyService
{
    public const int MaxPlayers = PoCabinetCatalog.CarCount;
    public const int MaxBots = 4;
    public const int DefaultBots = 3;
    private static readonly TimeSpan IdleLobbyLifetime = TimeSpan.FromMinutes(20);
    private static readonly char[] JoinCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray();

    private readonly object _gate = new();
    private readonly Dictionary<string, Lobby> _byCode = new(StringComparer.OrdinalIgnoreCase);
    private readonly TimeProvider _time;

    public PoCabinetLobbyService() : this(TimeProvider.System) { }

    public PoCabinetLobbyService(TimeProvider time) => _time = time;

    /// <summary>Open a lobby hosted by <paramref name="hostId"/>. Returns the join code.</summary>
    public string Open(string hostId, string displayName, bool isGuest, string? trackId,
        bool isPublic = false, string? color = null, string? connectionId = null)
    {
        lock (_gate)
        {
            PruneIdle();
            var code = GenerateJoinCode();
            var lobby = new Lobby(code, hostId, displayName,
                PoCabinetCatalog.IsKnownTrack(trackId) ? PoCabinetCatalog.GetTrack(trackId).Id : PoCabinetCatalog.DefaultTrackId)
            {
                IsPublic = isPublic,
                LastActivity = _time.GetUtcNow(),
            };
            var host = new LobbyPlayer(hostId, displayName, isGuest, isReady: true) { Color = SanitizeColor(color) };
            if (connectionId is not null) host.Connections.Add(connectionId);
            lobby.Players.Add(host);
            _byCode[code] = lobby;
            return code;
        }
    }

    /// <summary>
    /// Join an existing lobby. Idempotent for a player already seated (a reconnect or a
    /// rematch return). Null when the code is unknown, the race is running, or it is full.
    /// </summary>
    public Lobby? Join(string joinCode, string playerId, string displayName, bool isGuest,
        string? color = null, string? connectionId = null)
    {
        lock (_gate)
        {
            if (!_byCode.TryGetValue(joinCode, out var lobby)) return null;
            var existing = lobby.Players.FirstOrDefault(p => p.PlayerId == playerId);
            if (existing is not null)
            {
                if (connectionId is not null) existing.Connections.Add(connectionId);
                existing.Disconnected = false;
                if (color is not null) existing.Color = SanitizeColor(color);
                lobby.LastActivity = _time.GetUtcNow();
                return lobby;
            }
            if (lobby.IsStarted) return null;
            if (lobby.Players.Count >= MaxPlayers) return null;

            var player = new LobbyPlayer(playerId, displayName, isGuest, isReady: false) { Color = SanitizeColor(color) };
            if (connectionId is not null) player.Connections.Add(connectionId);
            lobby.Players.Add(player);
            lobby.LastActivity = _time.GetUtcNow();
            return lobby;
        }
    }

    /// <summary>Toggle the player's ready flag.</summary>
    public bool ToggleReady(string joinCode, string playerId)
    {
        lock (_gate)
        {
            if (!_byCode.TryGetValue(joinCode, out var lobby) || lobby.IsStarted) return false;
            var player = lobby.Players.FirstOrDefault(p => p.PlayerId == playerId);
            if (player is null) return false;
            player.IsReady = !player.IsReady;
            lobby.LastActivity = _time.GetUtcNow();
            return true;
        }
    }

    /// <summary>Host-only: switch the track for the next race.</summary>
    public bool SetTrack(string joinCode, string hostId, string? trackId)
    {
        lock (_gate)
        {
            if (!TryGetHostedIdle(joinCode, hostId, out var lobby) || !PoCabinetCatalog.IsKnownTrack(trackId)) return false;
            lobby.TrackId = PoCabinetCatalog.GetTrack(trackId).Id;
            lobby.LastActivity = _time.GetUtcNow();
            return true;
        }
    }

    /// <summary>Host-only: how many AI officials fill free seats (0–4).</summary>
    public bool SetBots(string joinCode, string hostId, int count)
    {
        lock (_gate)
        {
            if (!TryGetHostedIdle(joinCode, hostId, out var lobby)) return false;
            lobby.BotCount = Math.Clamp(count, 0, MaxBots);
            lobby.LastActivity = _time.GetUtcNow();
            return true;
        }
    }

    /// <summary>Host-only: list the lobby in the public browser or hide it (code-only).</summary>
    public bool SetPublic(string joinCode, string hostId, bool isPublic)
    {
        lock (_gate)
        {
            if (!TryGetHostedIdle(joinCode, hostId, out var lobby)) return false;
            lobby.IsPublic = isPublic;
            lobby.LastActivity = _time.GetUtcNow();
            return true;
        }
    }

    /// <summary>
    /// True if the host can begin: every seated human is ready and the grid would hold at least
    /// two cars once the AI officials are counted — a lone host with bots on can race.
    /// </summary>
    public bool CanStart(string joinCode, string hostId)
    {
        lock (_gate)
        {
            return _byCode.TryGetValue(joinCode, out var lobby) && CanStartLocked(lobby, hostId);
        }
    }

    /// <summary>Mark the lobby started and return it (the caller builds the grid from it).</summary>
    public Lobby? Start(string joinCode, string hostId)
    {
        lock (_gate)
        {
            if (!_byCode.TryGetValue(joinCode, out var lobby)) return null;
            if (lobby.IsStarted) return null; // idempotent: a started lobby cannot re-enter Start
            if (!CanStartLocked(lobby, hostId)) return null;
            lobby.IsStarted = true;
            lobby.LastActivity = _time.GetUtcNow();
            return lobby;
        }
    }

    /// <summary>
    /// The race for this lobby ended: reopen it for a rematch. Players who dropped during the
    /// race are removed now; everyone but the host has to ready up again.
    /// </summary>
    public Lobby? MarkRaceFinished(string joinCode)
    {
        lock (_gate)
        {
            if (!_byCode.TryGetValue(joinCode, out var lobby)) return null;
            lobby.IsStarted = false;
            foreach (var gone in lobby.Players.Where(p => p.Disconnected).ToList())
            {
                RemoveLocked(lobby, gone.PlayerId);
            }
            if (!_byCode.ContainsKey(joinCode)) return null;
            foreach (var p in lobby.Players) p.IsReady = p.PlayerId == lobby.HostId;
            lobby.LastActivity = _time.GetUtcNow();
            return lobby;
        }
    }

    /// <summary>Remove a player; close the lobby when the last one leaves.</summary>
    public void Leave(string joinCode, string playerId)
    {
        lock (_gate)
        {
            if (_byCode.TryGetValue(joinCode, out var lobby)) RemoveLocked(lobby, playerId);
        }
    }

    /// <summary>
    /// A SignalR connection closed. The owning player leaves any lobby where that was their
    /// last connection — immediately if the lobby is idle, at race end if a race is running
    /// (their car keeps its grid slot until then). Returns the codes whose roster changed.
    /// </summary>
    public IReadOnlyList<string> DropConnection(string connectionId)
    {
        lock (_gate)
        {
            var changed = new List<string>();
            foreach (var lobby in _byCode.Values.ToList())
            {
                var player = lobby.Players.FirstOrDefault(p => p.Connections.Contains(connectionId));
                if (player is null) continue;
                player.Connections.Remove(connectionId);
                if (player.Connections.Count > 0) continue;
                if (lobby.IsStarted) player.Disconnected = true;
                else RemoveLocked(lobby, player.PlayerId);
                changed.Add(lobby.Code);
            }
            return changed;
        }
    }

    public Lobby? GetByCode(string joinCode)
    {
        lock (_gate)
        {
            return _byCode.TryGetValue(joinCode, out var lobby) ? lobby : null;
        }
    }

    /// <summary>Public lobbies with a free seat, plus public races in progress (spectatable).</summary>
    public IReadOnlyList<PoCabinetLobbySummary> ListPublic()
    {
        lock (_gate)
        {
            PruneIdle();
            return _byCode.Values
                .Where(l => l.IsPublic && (l.IsStarted || l.Players.Count < MaxPlayers))
                .OrderBy(l => l.IsStarted)
                .ThenByDescending(l => l.LastActivity)
                .Take(20)
                .Select(l => new PoCabinetLobbySummary
                {
                    Code = l.Code,
                    HostName = l.HostDisplayName,
                    TrackId = l.TrackId,
                    Humans = l.Players.Count,
                    Bots = EffectiveBots(l),
                    InRace = l.IsStarted,
                })
                .ToList();
        }
    }

    /// <summary>Wire view of a lobby; <paramref name="forPlayerId"/> fills <c>YourSeatId</c>.</summary>
    public PoCabinetLobbyView? View(string joinCode, string? forPlayerId = null)
    {
        lock (_gate)
        {
            if (!_byCode.TryGetValue(joinCode, out var lobby)) return null;
            return new PoCabinetLobbyView
            {
                Code = lobby.Code,
                TrackId = lobby.TrackId,
                IsPublic = lobby.IsPublic,
                BotCount = lobby.BotCount,
                InRace = lobby.IsStarted,
                Players = lobby.Players.Select(p => new PoCabinetLobbySeat
                {
                    SeatId = SeatIdFor(lobby.Code, p.PlayerId),
                    DisplayName = p.DisplayName,
                    IsGuest = p.IsGuest,
                    IsReady = p.IsReady,
                    IsHost = p.PlayerId == lobby.HostId,
                    Color = p.Color,
                }).ToList(),
                YourSeatId = forPlayerId is null ? null : SeatIdFor(lobby.Code, forPlayerId),
            };
        }
    }

    /// <summary>
    /// The race grid for a started lobby: humans in seat order, then as many AI officials as
    /// asked for and fit. Snapshot taken under the lock so a late leave cannot tear it.
    /// </summary>
    public IReadOnlyList<PoCabinetDriver> BuildGrid(string joinCode)
    {
        lock (_gate)
        {
            if (!_byCode.TryGetValue(joinCode, out var lobby)) return [];
            var grid = lobby.Players
                .Select(p => new PoCabinetDriver(p.PlayerId, p.DisplayName, IsPlayer: true,
                    Color: string.IsNullOrEmpty(p.Color) ? "#3a7d44" : p.Color, Personality: null))
                .ToList();
            var roster = PoCabinetPersonality.Roster;
            for (int i = 0; i < EffectiveBots(lobby); i++)
            {
                var o = roster[i];
                grid.Add(new PoCabinetDriver($"bot-{i}", o.Name, IsPlayer: false, o.Color, o.Personality,
                    o.MaxSpeed, o.CorneringSkill, o.Id));
            }
            return grid;
        }
    }

    /// <summary>Opaque, per-lobby seat id: stable for a player, useless outside this lobby.</summary>
    public static string SeatIdFor(string code, string playerId)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(code.ToUpperInvariant() + "|" + playerId));
        return Convert.ToHexString(bytes, 0, 5).ToLowerInvariant();
    }

    private static int EffectiveBots(Lobby lobby) =>
        Math.Min(lobby.BotCount, Math.Max(0, MaxPlayers - lobby.Players.Count));

    private static bool CanStartLocked(Lobby lobby, string hostId)
    {
        if (lobby.IsStarted || lobby.HostId != hostId) return false;
        if (lobby.Players.Count == 0 || lobby.Players.Count + EffectiveBots(lobby) < 2) return false;
        return lobby.Players.All(p => p.IsReady);
    }

    private bool TryGetHostedIdle(string joinCode, string hostId, out Lobby lobby)
    {
        return _byCode.TryGetValue(joinCode, out lobby!) && lobby.HostId == hostId && !lobby.IsStarted;
    }

    private void RemoveLocked(Lobby lobby, string playerId)
    {
        lobby.Players.RemoveAll(p => p.PlayerId == playerId);
        if (lobby.Players.Count == 0)
        {
            _byCode.Remove(lobby.Code);
            return;
        }
        // If the host left, promote the first remaining player; they are ready by definition.
        if (lobby.HostId == playerId)
        {
            var newHost = lobby.Players[0];
            lobby.HostId = newHost.PlayerId;
            lobby.HostDisplayName = newHost.DisplayName;
            newHost.IsReady = true;
        }
        lobby.LastActivity = _time.GetUtcNow();
    }

    private void PruneIdle()
    {
        var cutoff = _time.GetUtcNow() - IdleLobbyLifetime;
        foreach (var stale in _byCode.Values.Where(l => !l.IsStarted && l.LastActivity < cutoff).ToList())
        {
            _byCode.Remove(stale.Code);
        }
    }

    /// <summary>Paint names from the paint shop or #rrggbb; anything else becomes empty (client default).</summary>
    private static string SanitizeColor(string? color)
    {
        if (string.IsNullOrWhiteSpace(color) || color.Length > 20) return "";
        return color.All(ch => char.IsAsciiLetterOrDigit(ch) || ch == '#') ? color : "";
    }

    private string GenerateJoinCode()
    {
        // 8-char alphanumeric (Crockford-style, no I/O/0/1 to avoid misread). Bounded
        // retry; 32^8 ≈ 1 trillion, collision is effectively zero in a real session.
        Span<char> buf = stackalloc char[8];
        for (int attempt = 0; attempt < 8; attempt++)
        {
            for (int i = 0; i < 8; i++)
                buf[i] = JoinCodeAlphabet[RandomNumberGenerator.GetInt32(JoinCodeAlphabet.Length)];
            var code = "CAB-" + new string(buf);
            if (!_byCode.ContainsKey(code)) return code;
        }
        // Fall back to a GUID-suffixed code; should never reach here in practice.
        return "CAB-" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();
    }

    public sealed class Lobby
    {
        public Lobby(string code, string hostId, string hostDisplayName, string trackId)
        {
            Code = code;
            HostId = hostId;
            HostDisplayName = hostDisplayName;
            TrackId = trackId;
        }

        public string Code { get; }
        public string HostId { get; set; }
        public string HostDisplayName { get; set; }
        public string TrackId { get; set; }
        public bool IsPublic { get; set; }
        public int BotCount { get; set; } = DefaultBots;
        public bool IsStarted { get; set; }
        public DateTimeOffset LastActivity { get; set; }
        public List<LobbyPlayer> Players { get; } = new();
    }

    public sealed class LobbyPlayer
    {
        public LobbyPlayer(string playerId, string displayName, bool isGuest, bool isReady)
        {
            PlayerId = playerId;
            DisplayName = displayName;
            IsGuest = isGuest;
            IsReady = isReady;
        }

        /// <summary>Claim-derived identity (never sent to other clients — see <see cref="SeatIdFor"/>).</summary>
        public string PlayerId { get; }
        public string DisplayName { get; }
        public bool IsGuest { get; }
        public bool IsReady { get; set; }
        public string Color { get; set; } = "";
        /// <summary>Live SignalR connections for this player (tabs, reconnects).</summary>
        public HashSet<string> Connections { get; } = new(StringComparer.Ordinal);
        /// <summary>Lost every connection mid-race; removed when the race ends.</summary>
        public bool Disconnected { get; set; }
    }
}
