using System.Text.Json.Serialization;
// Alias, not a namespace import: PoMiniGamesClient.Models mirrors several other Domain
// types by name, so importing the namespace wholesale would make them all ambiguous.
using PoSportsHighScore = PoMiniGames.Domain.Models.PoSportsHighScore;
using PoBrawlFighterRating = PoMiniGames.Domain.Models.PoBrawlFighterRating;
using PoMiniGamesClient.Models;
using PoMiniGames.Shared.Games;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Http;

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
// Auth
[JsonSerializable(typeof(AuthClientConfiguration))]
[JsonSerializable(typeof(AuthenticatedUserProfile))]
[JsonSerializable(typeof(DevLoginRequest))]
[JsonSerializable(typeof(AuthHandshake))]
// §2 CSRF: AntiforgeryHandler deserializes the token endpoint's payload through this
// context so the token fetch stays trim-safe (it runs on the WASM HttpClient pipeline).
[JsonSerializable(typeof(AntiforgeryTokenDto))]
// §2 /health status page
[JsonSerializable(typeof(HealthReportDto))]
// Score integrity + account data. Source-generated like everything else on this path:
// the mint runs on the WASM HttpClient pipeline and the erase result is read back on the
// profile page, both of which the trim analyzer sees.
[JsonSerializable(typeof(PlaySessionTicketDto))]
[JsonSerializable(typeof(AccountDeletionDto))]
// Stats + leaderboards
[JsonSerializable(typeof(PlayerStatsDto))]
[JsonSerializable(typeof(PlayerStatsDto[]))]
[JsonSerializable(typeof(PlayerStats))]
[JsonSerializable(typeof(AdaptiveRating))]
[JsonSerializable(typeof(MarbleRaceHighScore))]
[JsonSerializable(typeof(MarbleRaceHighScore[]))]
[JsonSerializable(typeof(MarbleRaceHighScoreRequest))]
[JsonSerializable(typeof(PoBrawlHighScore))]
[JsonSerializable(typeof(PoBrawlHighScore[]))]
// Single entry only — the client POSTs ladder progress but never reads the board back
// (the unified /api/leaderboards/pobrawl route serves it). The array registration went
// with GetPoBrawlLadderAsync on 2026-08-11.
[JsonSerializable(typeof(PoBrawlLadderEntry))]
[JsonSerializable(typeof(PoBrawlFighterRating))]
[JsonSerializable(typeof(PoBrawlFighterRating[]))]
[JsonSerializable(typeof(PoBrawlDemoResultRequest))]
[JsonSerializable(typeof(PoSportsHighScore))]
[JsonSerializable(typeof(PoSportsHighScore[]))]
[JsonSerializable(typeof(PoMiniGames.Domain.Models.PoVoxelStrikeHighScore))]
[JsonSerializable(typeof(PoMiniGames.Domain.Models.PoVoxelStrikeHighScore[]))]
[JsonSerializable(typeof(PoVoxelStrikeRunRequest))]
[JsonSerializable(typeof(PendingPlayerStats))]
[JsonSerializable(typeof(LeaderboardEntryDto))]
[JsonSerializable(typeof(GameLeaderboardDto))]
[JsonSerializable(typeof(GameLeaderboardDto[]))]
// Matches
[JsonSerializable(typeof(MatchRecordRequest))]
[JsonSerializable(typeof(MatchRecordDto))]
[JsonSerializable(typeof(MatchRecordDto[]))]
// PoFunQuiz
[JsonSerializable(typeof(QuizQuestion))]
[JsonSerializable(typeof(List<QuizQuestion>))]
[JsonSerializable(typeof(FunQuizLeaderboardRow))]
[JsonSerializable(typeof(List<FunQuizLeaderboardRow>))]
[JsonSerializable(typeof(FunQuizLeaderboardRow[]))]
[JsonSerializable(typeof(FunQuizLeaderboardSubmission))]
// PoJoker
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoJoker.JokeDto))]
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoJoker.JokeFlags))]
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoJoker.JokeAnalysisDto))]
// Disambiguate from client-side LeaderboardEntryDto: name the source-gen
// metadata property JokerLeaderboardEntryDto so the PoJoker leaderboard page
// resolves it.
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoJoker.LeaderboardEntryDto), TypeInfoPropertyName = "JokerLeaderboardEntryDto")]
[JsonSerializable(typeof(List<PoMiniGames.Shared.Games.PoJoker.LeaderboardEntryDto>), TypeInfoPropertyName = "ListJokerLeaderboardEntryDto")]
// PoRacer
[JsonSerializable(typeof(PoRacerScoreDto))]
[JsonSerializable(typeof(List<PoRacerScoreDto>))]
internal partial class ApiJsonContext : JsonSerializerContext
{
}
