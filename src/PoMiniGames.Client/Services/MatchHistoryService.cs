using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services;

/// <summary>
/// Records and reads the local player's head-to-head match results (local 2P and
/// online multiplayer). The "owner" identity is the signed-in Microsoft email when
/// available, otherwise the guest display name — so both authenticated and guest
/// players build up a personal opponent record on the server.
/// </summary>
public sealed class MatchHistoryService
{
    private readonly ApiService _api;
    private readonly AuthStateService _auth;
    private readonly PlayerNameService _playerName;

    public MatchHistoryService(ApiService api, AuthStateService auth, PlayerNameService playerName)
    {
        _api = api;
        _auth = auth;
        _playerName = playerName;
    }

    /// <summary>The current player's owner key + type used to scope their match history.</summary>
    public (string Owner, string OwnerType) ResolveOwner()
    {
        var email = _auth.User?.Email;
        if (!string.IsNullOrWhiteSpace(email))
            return (email.Trim(), "microsoft");

        var display = _auth.User?.DisplayName;
        if (!string.IsNullOrWhiteSpace(display))
            return (display.Trim(), "microsoft");

        var guest = _playerName.GetPlayerName();
        return (string.IsNullOrWhiteSpace(guest) ? "Player" : guest, "guest");
    }

    /// <summary>The display label for the current player (what opponents would see).</summary>
    public string MyDisplayName() => ResolveOwner().Owner;

    /// <summary>
    /// Records one finished head-to-head result. Best-effort: never throws, so a
    /// game's end-of-match flow is unaffected when the backend is unreachable.
    /// </summary>
    public async Task RecordAsync(string game, MatchMode mode, string opponentName, MatchOutcome outcome, string? opponentType = null)
    {
        if (string.IsNullOrWhiteSpace(opponentName)) return;

        var (owner, ownerType) = ResolveOwner();
        // Don't record a match against yourself (can happen when scores tie names in a lobby).
        if (string.Equals(owner, opponentName, StringComparison.OrdinalIgnoreCase)) return;

        await _api.RecordMatchAsync(new MatchRecordRequest
        {
            Owner = owner,
            OwnerType = ownerType,
            Game = game,
            Mode = mode == MatchMode.Local2P ? "local-2p" : "multiplayer",
            OpponentName = opponentName.Trim(),
            OpponentType = opponentType ?? (opponentName.Contains('@') ? "microsoft" : "guest"),
            Outcome = outcome switch
            {
                MatchOutcome.Win => "win",
                MatchOutcome.Loss => "loss",
                _ => "draw"
            }
        });
    }

    public async Task<MatchRecordDto[]> GetMyMatchesAsync(int limit = 500)
    {
        var (owner, _) = ResolveOwner();
        return await _api.GetMatchesAsync(owner, limit) ?? [];
    }
}

public enum MatchMode { Local2P, Multiplayer }

public enum MatchOutcome { Win, Loss, Draw }
