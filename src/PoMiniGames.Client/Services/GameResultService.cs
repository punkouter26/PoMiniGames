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

    public GameResultService(GameStatsService stats, ApiService api)
    {
        _stats = stats;
        _api = api;
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
            await _api.SubmitMarbleRaceHighScoreAsync(highScore);
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
            await _api.SubmitSnakeHighScoreAsync(highScore);
        }
        return stats;
    }
}
