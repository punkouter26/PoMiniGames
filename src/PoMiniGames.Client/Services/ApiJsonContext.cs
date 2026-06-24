using System.Text.Json.Serialization;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services;

/// <summary>
/// Source-generated <see cref="JsonSerializerContext"/> for the DTOs exchanged by
/// <see cref="ApiService"/>. Using generated metadata for these hot leaderboard/stats
/// payloads avoids the reflection-based serializer's per-type startup cost and is trim/AOT
/// friendly (no IL2026). It is chained ahead of a reflection fallback in
/// <see cref="ApiService"/>, so any type not listed here still serializes correctly — this
/// is an additive fast path, not a wire-format change.
/// </summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    UseStringEnumConverter = true)]
[JsonSerializable(typeof(AuthClientConfiguration))]
[JsonSerializable(typeof(AuthenticatedUserProfile))]
[JsonSerializable(typeof(DevLoginRequest))]
[JsonSerializable(typeof(PlayerStatsDto))]
[JsonSerializable(typeof(PlayerStatsDto[]))]
[JsonSerializable(typeof(PlayerStats))]
[JsonSerializable(typeof(SnakeHighScore))]
[JsonSerializable(typeof(SnakeHighScore[]))]
[JsonSerializable(typeof(MarbleRaceHighScore))]
[JsonSerializable(typeof(MarbleRaceHighScore[]))]
[JsonSerializable(typeof(MatchRecordRequest))]
[JsonSerializable(typeof(MatchRecordDto))]
[JsonSerializable(typeof(MatchRecordDto[]))]
internal sealed partial class ApiJsonContext : JsonSerializerContext
{
}
