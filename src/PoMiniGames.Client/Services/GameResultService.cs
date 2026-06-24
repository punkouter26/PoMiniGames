using PoMiniGamesClient.Enums;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services;

/// <summary>
/// The single intake every game reports an outcome to. It owns "what happens when a game ends":
/// local stats are always recorded, and a server high score is submitted in the same awaited step
/// when one is supplied — so the two writes can no longer desync the way a fire-and-forget submit can.
/// </summary>
/// <remarks>
/// Pattern: a deep module over two adapters. Local stats (<see cref="GameStatsService"/>) and the
/// server board (<see cref="ApiService"/>) sit behind one interface, concentrating outcome handling
/// in one place instead of each game wiring both — or routing around one of them.
/// </remarks>
public sealed class GameResultService
{
    private readonly GameStatsService _stats;
    private readonly ApiService _api;
    private readonly ScoreSyncService _sync;

    public GameResultService(GameStatsService stats, ApiService api, ScoreSyncService sync)
    {
        _stats = stats;
        _api = api;
        _sync = sync;
    }

    /// <summary>Records a local-only outcome (the common path for games without a server board).</summary>
    public Task<PlayerStats> RecordAsync(string gameKey, string playerName, Difficulty difficulty, GameResult result) =>
        _stats.RecordResult(gameKey, playerName, difficulty, result);

    /// <summary>
    /// Records the local outcome and, when <paramref name="highScore"/> is supplied, submits it to the
    /// server board in the same awaited call. One report, both writes, consistent ordering.
    /// </summary>
    public async Task<PlayerStats> RecordAndSubmitMarbleRaceAsync(
        string playerName, GameResult result, MarbleRaceHighScore? highScore)
    {
        var stats = await _stats.RecordResult("pomarblerace", playerName, Difficulty.Medium, result);
        if (highScore is not null)
        {
            // If the server board can't be reached, park the score so it syncs on reconnect
            // instead of being silently lost — the leaderboard is the platform's North Star.
            if (await _api.SubmitMarbleRaceHighScoreAsync(highScore) is null)
            {
                _sync.EnqueueMarbleRace(highScore);
            }
        }
        return stats;
    }

    /// <summary>Records the snake outcome locally and submits the high score together.</summary>
    public async Task<PlayerStats> RecordAndSubmitSnakeAsync(
        string playerName, Difficulty difficulty, GameResult result, SnakeHighScore? highScore)
    {
        var stats = await _stats.RecordResult("posnakegame", playerName, difficulty, result);
        if (highScore is not null)
        {
            if (await _api.SubmitSnakeHighScoreAsync(highScore) is null)
            {
                _sync.EnqueueSnake(highScore);
            }
        }
        return stats;
    }
}
