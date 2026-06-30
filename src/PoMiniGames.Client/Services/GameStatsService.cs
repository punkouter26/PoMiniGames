using Microsoft.JSInterop;
using PoMiniGamesClient.Enums;
using PoMiniGamesClient.Models;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace PoMiniGamesClient.Services;

public class GameStatsService
{
    private static readonly Dictionary<string, PlayerStats> _statsCache = new();
    private const string StorageKeyPrefix = "pomini_stats_";
    private const string LastGameKey = "pomini_last_game";

    public PlayerStats GetStats(string gameKey, string playerName)
    {
        var cacheKey = $"{gameKey}_{playerName}";
        if (_statsCache.TryGetValue(cacheKey, out var cached))
            return cached;

        var storageKey = $"{StorageKeyPrefix}{gameKey}";
        var stored = LocalStorageService.GetItem(storageKey, ApiJsonContext.Default.PlayerStats);
        if (stored != null && stored.PlayerName == playerName)
        {
            _statsCache[cacheKey] = stored;
            return stored;
        }

        var newStats = new PlayerStats
        {
            PlayerId = GetOrCreatePlayerId(),
            PlayerName = playerName
        };
        _statsCache[cacheKey] = newStats;
        return newStats;
    }

    public DifficultyStats GetDifficultyBucket(PlayerStats stats, Difficulty difficulty)
    {
        return difficulty switch
        {
            Difficulty.Easy => stats.Easy,
            Difficulty.Medium => stats.Medium,
            Difficulty.Hard => stats.Hard,
            _ => stats.Medium
        };
    }

    public async Task<PlayerStats> RecordResult(string gameKey, string playerName, Difficulty difficulty, GameResult result)
    {
        var stats = GetStats(gameKey, playerName);
        var bucket = GetDifficultyBucket(stats, difficulty);

        switch (result)
        {
            case GameResult.Win:
                bucket.Wins++;
                bucket.WinStreak++;
                break;
            case GameResult.Loss:
                bucket.Losses++;
                bucket.WinStreak = 0;
                break;
            case GameResult.Draw:
                bucket.Draws++;
                bucket.WinStreak = 0;
                break;
        }

        bucket.EloRating = ComputeEloRating(bucket, difficulty);
        await SaveStats(gameKey, stats);
        return stats;
    }

    public async Task SaveStats(string gameKey, PlayerStats stats)
    {
        var cacheKey = $"{gameKey}_{stats.PlayerName}";
        _statsCache[cacheKey] = stats;
        var storageKey = $"{StorageKeyPrefix}{gameKey}";
        LocalStorageService.SetItem(storageKey, stats, ApiJsonContext.Default.PlayerStats);
    }

    // UX 10: Offline-First - Track last played game
    public GameCard? GetLastPlayedGame()
    {
        var lastGameKey = LocalStorageService.GetItem<string>(LastGameKey);
        if (string.IsNullOrEmpty(lastGameKey))
            return null;

        var gameTitle = lastGameKey switch
        {
            "connectfive" => "Connect Five",
            "tictactoe" => "Tic Tac Toe",
            "voxelshooter" => "Voxel Shooter",
            "pofight" => "PoFight",
            "podropsquare" => "PoDropSquare",
            "pobabytouch" => "PoBabyTouch",
            "poraceragdoll" => "PoRaceRagdoll",
            "posnakegame" => "PoSnakeGame",
            "pohorserace" => "PoHorseRace",
            "porunner" => "PoRunner",
            "poracer" => "PoRacer",
            "pomarblerace" => "PoMarbleRace",
            _ => lastGameKey
        };

        return new GameCard(gameTitle, $"/{lastGameKey}");
    }

    public void SaveLastPlayedGame(string gameKey)
    {
        LocalStorageService.SetItem(LastGameKey, gameKey);
    }

    public record GameCard(string Title, string Url);

    private int ComputeEloRating(DifficultyStats ds, Difficulty difficulty)
    {
        var aiElo = difficulty switch
        {
            Difficulty.Easy => 800,
            Difficulty.Medium => 1200,
            Difficulty.Hard => 1600,
            _ => 1200
        };

        if (ds.TotalGames == 0) return 1000;

        var K = 32;
        var expected = 1.0 / (1.0 + Math.Pow(10, (aiElo - 1000) / 400.0));
        var elo = 1000
            + ds.Wins * K * (1.0 - expected)
            + ds.Draws * K * (0.5 - expected)
            + ds.Losses * K * (0.0 - expected);

        return Math.Max(0, (int)Math.Round(elo));
    }

    private string GetOrCreatePlayerId()
    {
        const string StorageKey = "pomini_player_id";
        var playerId = LocalStorageService.GetItem<string>(StorageKey);
        if (string.IsNullOrEmpty(playerId))
        {
            playerId = $"po_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid().ToString("N")[..7]}";
            LocalStorageService.SetItem(StorageKey, playerId);
        }
        return playerId;
    }
}

public static class LocalStorageService
{
    private static IJSRuntime? _jsRuntime;

    public static void SetJSRuntime(IJSRuntime jsRuntime)
    {
        _jsRuntime = jsRuntime;
    }

    public static T? GetItem<T>(string key, JsonTypeInfo<T>? typeInfo = null)
    {
        if (_jsRuntime == null) return default;
        try
        {
            if (typeof(T) == typeof(string))
            {
                var raw = _jsRuntime.InvokeAsync<string>("window.localStorage.getItem", key).AsTask().Result;
                if (raw is null) return default;
                // If the stored value is a JSON-encoded string (e.g. "\"CalmTiger42\""), decode it
                if (raw.Length >= 2 && raw[0] == '"' && raw[^1] == '"')
                {
                    try { return (T)(object)JsonDocument.Parse(raw).RootElement.GetString()!; }
                    catch { /* fall through to raw */ }
                }
                return (T)(object)raw;
            }
            if (typeInfo is null) return default;
            var rawJson = _jsRuntime.InvokeAsync<string>("window.localStorage.getItem", key).AsTask().Result;
            if (rawJson is null) return default;
            return JsonSerializer.Deserialize(rawJson, typeInfo);
        }
        catch
        {
            return default;
        }
    }

    public static void SetItem<T>(string key, T value, JsonTypeInfo<T>? typeInfo = null)
    {
        if (_jsRuntime == null) return;
        try
        {
            if (value is string s)
            {
                _jsRuntime.InvokeVoidAsync("window.localStorage.setItem", key, s);
            }
            else if (typeInfo is not null)
            {
                var json = JsonSerializer.Serialize(value, typeInfo);
                _jsRuntime.InvokeVoidAsync("window.localStorage.setItem", key, json);
            }
        }
        catch { }
    }
}
