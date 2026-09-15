using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.ConnectFive;

/// <summary>
/// Process-local quick-match queue and authoritative match state for online
/// Connect Five. The service owns every board: a client sends a column, the
/// service validates the seat, the turn and gravity, applies the disc through
/// <see cref="ConnectFiveRules"/>, and hands back the snapshot both seats render.
/// </summary>
/// <remarks>
/// <para>
/// There is no lobby, host or ready check. A turn-based two-seat game needs none of
/// that: the first two arrivals are paired, colours are drawn at random, and a
/// rematch swaps them. That is deliberately less machinery than the PoBrawl/PoRacer
/// lobbies carry, because there is nothing to pick before play starts.
/// </para>
/// <para>
/// Seats are bound to a <b>seat token</b>, not a connection id. SignalR's automatic
/// reconnect hands the client a new connection id, so a 30 s WebSocket drop would
/// otherwise orphan the seat. A dropped seat is kept for <see cref="DisconnectGrace"/>
/// and the opponent is told it is waiting; if the token never comes back the match is
/// forfeited to whoever stayed. That timer is the one path where the service, not
/// the hub, broadcasts — hence the <see cref="IHubContext{THub}"/> dependency.
/// </para>
/// <para>
/// Process-local like every other live-play registry in the host: a restart drops
/// the matches, and a game that takes two minutes has no reason to outlive it.
/// </para>
/// </remarks>
public sealed class ConnectFiveMatchService
{
    /// <summary>How long a dropped seat is held before the match is forfeited to the opponent.</summary>
    public static readonly TimeSpan DisconnectGrace = TimeSpan.FromSeconds(30);

    private readonly IHubContext<ConnectFiveHub> _hub;
    private readonly ILogger<ConnectFiveMatchService> _log;
    private readonly object _lock = new();

    private readonly List<Waiting> _queue = new();
    private readonly Dictionary<string, Match> _byConnection = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Match> _byToken = new(StringComparer.Ordinal);

    public ConnectFiveMatchService(IHubContext<ConnectFiveHub> hub, ILogger<ConnectFiveMatchService> log)
    {
        _hub = hub;
        _log = log;
    }

    public static string GroupFor(string matchId) => $"connectfive-match-{matchId}";

    /// <summary>Number of connections waiting to be paired. Diagnostics only.</summary>
    public int WaitingCount { get { lock (_lock) return _queue.Count; } }

    // ── Queue ───────────────────────────────────────────────────────────

    /// <summary>
    /// Join the quick-match queue. Returns the new match when this arrival completed a
    /// pair, else null. A connection already seated is returned to its match unchanged,
    /// and a connection already waiting keeps its place.
    /// </summary>
    public Pairing? Enqueue(string connectionId, string principalId, string displayName, bool isGuest)
    {
        lock (_lock)
        {
            if (_byConnection.ContainsKey(connectionId)) return null;
            if (_queue.Any(w => w.ConnectionId == connectionId)) return null;

            var arrival = new Waiting(connectionId, SanitizePrincipal(principalId), SanitizeName(displayName), isGuest);
            if (_queue.Count == 0)
            {
                _queue.Add(arrival);
                return null;
            }

            var partner = _queue[0];
            _queue.RemoveAt(0);

            // Colour is drawn, not "first arrival is Red": the queue order is
            // invisible to both players, so a fixed rule would just be an unexplained
            // disadvantage for whoever the server happened to see second.
            var partnerIsRed = Random.Shared.Next(2) == 0;
            var red = partnerIsRed ? partner : arrival;
            var yellow = partnerIsRed ? arrival : partner;

            var match = new Match(Guid.NewGuid().ToString("N"), new Seat(red, ConnectFiveColour.Red), new Seat(yellow, ConnectFiveColour.Yellow));
            _byConnection[red.ConnectionId] = match;
            _byConnection[yellow.ConnectionId] = match;
            _byToken[match.Red.Token] = match;
            _byToken[match.Yellow.Token] = match;

            _log.LogInformation("ConnectFive: paired {Red} (red) vs {Yellow} (yellow) as match {MatchId}",
                red.DisplayName, yellow.DisplayName, match.MatchId);
            return match.Pairing();
        }
    }

    public void Dequeue(string connectionId)
    {
        lock (_lock) _queue.RemoveAll(w => w.ConnectionId == connectionId);
    }

    // ── Play ────────────────────────────────────────────────────────────

    /// <summary>
    /// Drop a disc in <paramref name="col"/> for the seat behind <paramref name="connectionId"/>.
    /// Throws <see cref="InvalidOperationException"/> with a player-readable message on
    /// any rejected move; the hub relays it as a <see cref="HubException"/>.
    /// </summary>
    public ConnectFiveMatchState Drop(string connectionId, int col)
    {
        lock (_lock)
        {
            var match = RequireMatch(connectionId);
            var seat = match.SeatFor(connectionId);
            if (match.Status != ConnectFiveMatchStatus.InProgress) throw new InvalidOperationException("The game is over.");
            if (seat.Colour != match.Turn) throw new InvalidOperationException("It is not your turn.");
            if (col < 0 || col >= ConnectFiveRules.Cols) throw new InvalidOperationException("That column is off the board.");

            var row = ConnectFiveRules.TargetRow(match.Cells, col);
            if (row < 0) throw new InvalidOperationException("That column is full.");

            var colour = (byte)seat.Colour;
            match.Cells[row * ConnectFiveRules.Cols + col] = colour;
            match.MoveCount++;
            match.LastMove = new ConnectFiveMove(row, col, seat.Colour);

            var line = ConnectFiveRules.FindWin(match.Cells, colour);
            if (line is not null)
            {
                match.Finish(seat.Colour == ConnectFiveColour.Red ? ConnectFiveMatchStatus.RedWon : ConnectFiveMatchStatus.YellowWon,
                    ConnectFiveEndReason.FiveInARow, line);
            }
            else if (ConnectFiveRules.IsFull(match.Cells))
            {
                match.Finish(ConnectFiveMatchStatus.Draw, ConnectFiveEndReason.BoardFull, []);
            }
            else
            {
                match.Turn = Other(match.Turn);
            }
            return match.Snapshot();
        }
    }

    /// <summary>
    /// Vote for a rematch. When both seats have voted the board resets, colours swap
    /// and the game number increments; the returned pairing carries each seat's new
    /// start record so the hub can tell them their colour. Null pairing = still waiting.
    /// </summary>
    public (ConnectFiveMatchState State, Pairing? Rematch) RequestRematch(string connectionId)
    {
        lock (_lock)
        {
            var match = RequireMatch(connectionId);
            if (match.Status == ConnectFiveMatchStatus.InProgress) throw new InvalidOperationException("The game is still in progress.");
            var seat = match.SeatFor(connectionId);
            seat.WantsRematch = true;
            if (!match.Red.WantsRematch || !match.Yellow.WantsRematch) return (match.Snapshot(), null);

            match.ResetForRematch();
            _log.LogInformation("ConnectFive: match {MatchId} rematch, game {Game}", match.MatchId, match.GameNumber);
            return (match.Snapshot(), match.Pairing());
        }
    }

    /// <summary>
    /// Explicit leave. An in-progress game is forfeited to the opponent; a finished
    /// one just loses the seat. Returns the state to broadcast, or null when the
    /// connection was not seated (a queued connection is simply dequeued).
    /// </summary>
    public ConnectFiveMatchState? Leave(string connectionId)
    {
        lock (_lock)
        {
            _queue.RemoveAll(w => w.ConnectionId == connectionId);
            if (!_byConnection.TryGetValue(connectionId, out var match)) return null;
            var seat = match.SeatFor(connectionId);
            if (match.Status == ConnectFiveMatchStatus.InProgress)
            {
                match.Finish(WinnerAgainst(seat.Colour), ConnectFiveEndReason.Forfeit, []);
            }
            Unseat(match, seat);
            return match.Snapshot();
        }
    }

    /// <summary>
    /// Transport disconnect. Unlike <see cref="Leave"/> the seat is kept: the token can
    /// <see cref="Rejoin"/> inside <see cref="DisconnectGrace"/>. Returns the state to
    /// broadcast so the opponent sees the seat go dark, or null when nothing changed.
    /// </summary>
    public ConnectFiveMatchState? Disconnected(string connectionId)
    {
        lock (_lock)
        {
            _queue.RemoveAll(w => w.ConnectionId == connectionId);
            if (!_byConnection.TryGetValue(connectionId, out var match)) return null;
            var seat = match.SeatFor(connectionId);
            _byConnection.Remove(connectionId);
            seat.Connected = false;
            seat.ConnectionId = "";
            seat.DisconnectEpoch++;

            if (match.Status != ConnectFiveMatchStatus.InProgress)
            {
                // Nothing to forfeit; drop the match once nobody is left holding a seat.
                if (!match.Red.Connected && !match.Yellow.Connected) Forget(match);
                return match.Snapshot();
            }

            var epoch = seat.DisconnectEpoch;
            _ = ForfeitAfterGraceAsync(match, seat, epoch);
            return match.Snapshot();
        }
    }

    /// <summary>
    /// Re-bind a seat to a fresh connection after a reconnect. Null when the token is
    /// unknown (the match was forfeited or the host restarted), in which case the client
    /// should go back to the queue.
    /// </summary>
    public ConnectFiveRejoinResult? Rejoin(string connectionId, string seatToken)
    {
        lock (_lock)
        {
            if (string.IsNullOrEmpty(seatToken) || !_byToken.TryGetValue(seatToken, out var match)) return null;
            var seat = match.Red.Token == seatToken ? match.Red : match.Yellow;
            if (!string.IsNullOrEmpty(seat.ConnectionId)) _byConnection.Remove(seat.ConnectionId);
            seat.ConnectionId = connectionId;
            seat.Connected = true;
            seat.DisconnectEpoch++; // invalidates any pending forfeit timer
            _byConnection[connectionId] = match;
            return new ConnectFiveRejoinResult(match.StartFor(seat), match.Snapshot());
        }
    }

    // ── Internals ───────────────────────────────────────────────────────

    private async Task ForfeitAfterGraceAsync(Match match, Seat seat, int epoch)
    {
        try
        {
            await Task.Delay(DisconnectGrace);
            ConnectFiveMatchState? state = null;
            lock (_lock)
            {
                // The seat came back (epoch moved) or the game already ended some other way.
                if (seat.DisconnectEpoch != epoch || seat.Connected) return;
                if (match.Status == ConnectFiveMatchStatus.InProgress)
                {
                    match.Finish(WinnerAgainst(seat.Colour), ConnectFiveEndReason.Disconnect, []);
                    state = match.Snapshot();
                }
                Unseat(match, seat);
            }
            if (state is not null)
            {
                _log.LogInformation("ConnectFive: match {MatchId} forfeited by disconnect ({Colour})", match.MatchId, seat.Colour);
                await _hub.Clients.Group(GroupFor(match.MatchId)).SendAsync("state", state);
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "ConnectFive: disconnect-forfeit broadcast failed for match {MatchId}", match.MatchId);
        }
    }

    private void Unseat(Match match, Seat seat)
    {
        if (!string.IsNullOrEmpty(seat.ConnectionId)) _byConnection.Remove(seat.ConnectionId);
        _byToken.Remove(seat.Token);
        seat.ConnectionId = "";
        seat.Connected = false;
        seat.DisconnectEpoch++;
        var other = seat == match.Red ? match.Yellow : match.Red;
        if (!other.Connected) Forget(match);
    }

    private void Forget(Match match)
    {
        _byToken.Remove(match.Red.Token);
        _byToken.Remove(match.Yellow.Token);
        if (!string.IsNullOrEmpty(match.Red.ConnectionId)) _byConnection.Remove(match.Red.ConnectionId);
        if (!string.IsNullOrEmpty(match.Yellow.ConnectionId)) _byConnection.Remove(match.Yellow.ConnectionId);
    }

    private Match RequireMatch(string connectionId) =>
        _byConnection.TryGetValue(connectionId, out var match)
            ? match
            : throw new InvalidOperationException("You are not in a match.");

    private static ConnectFiveColour Other(ConnectFiveColour c) =>
        c == ConnectFiveColour.Red ? ConnectFiveColour.Yellow : ConnectFiveColour.Red;

    private static ConnectFiveMatchStatus WinnerAgainst(ConnectFiveColour loser) =>
        loser == ConnectFiveColour.Red ? ConnectFiveMatchStatus.YellowWon : ConnectFiveMatchStatus.RedWon;

    private static string SanitizeName(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "Player";
        var trimmed = raw.Trim();
        return trimmed.Length > 24 ? trimmed[..24] : trimmed;
    }

    private static string SanitizePrincipal(string raw) =>
        string.IsNullOrWhiteSpace(raw) ? "anon" : raw.Trim().ToLowerInvariant();

    /// <summary>
    /// What the hub needs to announce a game start: each seat's connection id with its
    /// private start record, plus the shared board. Connection ids are exposed here and
    /// nowhere else, because the hub has to address the private records individually.
    /// </summary>
    public sealed record Pairing(
        string MatchId,
        IReadOnlyList<(string ConnectionId, ConnectFiveMatchStart Start)> Connections,
        ConnectFiveMatchState State);

    private sealed record Waiting(string ConnectionId, string PrincipalId, string DisplayName, bool IsGuest);

    private sealed class Seat
    {
        public Seat(Waiting from, ConnectFiveColour colour)
        {
            ConnectionId = from.ConnectionId;
            PrincipalId = from.PrincipalId;
            DisplayName = from.DisplayName;
            IsGuest = from.IsGuest;
            Colour = colour;
            Token = Guid.NewGuid().ToString("N");
            Connected = true;
        }

        public string ConnectionId { get; set; }
        public string PrincipalId { get; }
        public string DisplayName { get; }
        public bool IsGuest { get; }
        public string Token { get; }
        public ConnectFiveColour Colour { get; set; }
        public bool Connected { get; set; }
        public bool WantsRematch { get; set; }
        /// <summary>Bumped on every connect/disconnect so a stale grace timer can tell it lost the race.</summary>
        public int DisconnectEpoch { get; set; }

        public ConnectFiveSeat Public() => new(DisplayName, IsGuest, Colour, Connected, WantsRematch);
    }

    private sealed class Match
    {
        public Match(string matchId, Seat red, Seat yellow)
        {
            MatchId = matchId;
            Red = red;
            Yellow = yellow;
        }

        public string MatchId { get; }
        public int GameNumber { get; private set; } = 1;
        public Seat Red { get; private set; }
        public Seat Yellow { get; private set; }
        public byte[] Cells { get; private set; } = new byte[ConnectFiveRules.CellCount];
        public int MoveCount { get; set; }
        public ConnectFiveColour Turn { get; set; } = ConnectFiveColour.Red;
        public ConnectFiveMatchStatus Status { get; private set; } = ConnectFiveMatchStatus.InProgress;
        public ConnectFiveEndReason EndReason { get; private set; } = ConnectFiveEndReason.None;
        public ConnectFiveMove? LastMove { get; set; }
        public int[] WinCells { get; private set; } = [];

        public Seat SeatFor(string connectionId) =>
            Red.ConnectionId == connectionId ? Red
            : Yellow.ConnectionId == connectionId ? Yellow
            : throw new InvalidOperationException("You are not seated in this match.");

        public void Finish(ConnectFiveMatchStatus status, ConnectFiveEndReason reason, int[] winCells)
        {
            Status = status;
            EndReason = reason;
            WinCells = winCells;
        }

        /// <summary>Fresh board, colours swapped, Red to move. Both seats keep their tokens.</summary>
        public void ResetForRematch()
        {
            (Red, Yellow) = (Yellow, Red);
            Red.Colour = ConnectFiveColour.Red;
            Yellow.Colour = ConnectFiveColour.Yellow;
            Red.WantsRematch = false;
            Yellow.WantsRematch = false;
            Cells = new byte[ConnectFiveRules.CellCount];
            MoveCount = 0;
            Turn = ConnectFiveColour.Red;
            Status = ConnectFiveMatchStatus.InProgress;
            EndReason = ConnectFiveEndReason.None;
            LastMove = null;
            WinCells = [];
            GameNumber++;
        }

        public ConnectFiveMatchStart StartFor(Seat seat) =>
            new(MatchId, GameNumber, seat.Token, seat.Colour, Red.Public(), Yellow.Public());

        public Pairing Pairing() =>
            new(MatchId, [(Red.ConnectionId, StartFor(Red)), (Yellow.ConnectionId, StartFor(Yellow))], Snapshot());

        public ConnectFiveMatchState Snapshot() =>
            new(MatchId, GameNumber, (byte[])Cells.Clone(), MoveCount, Turn, Status, EndReason, LastMove,
                (int[])WinCells.Clone(), Red.Public(), Yellow.Public(), DateTimeOffset.UtcNow);
    }
}
