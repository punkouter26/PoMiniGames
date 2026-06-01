using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services;

/// <summary>
/// Manages local PoClick session history via localStorage.
/// </summary>
public class PoClickHistoryService
{
    private const string StorageKey = "poclick_sessions";
    private const int MaxSessions = 50;

    /// <summary>
    /// Save a completed session to local history.
    /// </summary>
    public void SaveSession(PoClickSession session)
    {
        var sessions = GetSessions();
        sessions.Insert(0, session);

        // Cap history size
        if (sessions.Count > MaxSessions)
            sessions = sessions.Take(MaxSessions).ToList();

        LocalStorageService.SetItem(StorageKey, sessions);
    }

    /// <summary>
    /// Get all stored sessions, most recent first.
    /// </summary>
    public List<PoClickSession> GetSessions()
    {
        return LocalStorageService.GetItem<List<PoClickSession>>(StorageKey) ?? new();
    }

    /// <summary>
    /// Get a single session by ID.
    /// </summary>
    public PoClickSession? GetSession(string sessionId)
    {
        return GetSessions().FirstOrDefault(s => s.Id == sessionId);
    }

    /// <summary>
    /// Get the player's session history.
    /// </summary>
    public List<PoClickSession> GetPlayerHistory(string playerName)
    {
        return GetSessions()
            .Where(s => s.PlayerName == playerName)
            .ToList();
    }

    /// <summary>
    /// Get top scores across all sessions (leaderboard).
    /// </summary>
    public List<PoClickSession> GetLeaderboard(int limit = 10)
    {
        return GetSessions()
            .OrderByDescending(s => s.Score)
            .Take(limit)
            .ToList();
    }
}