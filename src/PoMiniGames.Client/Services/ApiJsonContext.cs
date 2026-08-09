using System.Text.Json.Serialization;
// Alias, not a namespace import: PoMiniGamesClient.Models mirrors several other Domain
// types by name, so importing the namespace wholesale would make them all ambiguous.
using PoSportsHighScore = PoMiniGames.Domain.Models.PoSportsHighScore;
using PoBrawlFighterRating = PoMiniGames.Domain.Models.PoBrawlFighterRating;
using PoMiniGamesClient.Models;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Games.PoSurvive.Services;
using PoMiniGames.Shared.Simulation.Models;

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
[JsonSerializable(typeof(PoBrawlLadderEntry))]
[JsonSerializable(typeof(PoBrawlLadderEntry[]))]
[JsonSerializable(typeof(PoBrawlFighterRating))]
[JsonSerializable(typeof(PoBrawlFighterRating[]))]
[JsonSerializable(typeof(PoBrawlDemoResultRequest))]
[JsonSerializable(typeof(PoSportsHighScore))]
[JsonSerializable(typeof(PoSportsHighScore[]))]
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
// PoCoupleQuiz
[JsonSerializable(typeof(CoupleQuizTeamRow))]
[JsonSerializable(typeof(List<CoupleQuizTeamRow>))]
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
// PoSurvive — inference
[JsonSerializable(typeof(InferRequestDto))]
[JsonSerializable(typeof(InferenceResult))]
[JsonSerializable(typeof(InferenceStatusDto))]
[JsonSerializable(typeof(PersonalityDnaDto))]
[JsonSerializable(typeof(GridStateDto))]
// PoSurvive — evolution
// Only /api/evolution/record survives on the client; the state/tree/summary and
// evolve/crossover contexts went out with EvolutionLab and its server endpoints.
[JsonSerializable(typeof(RecordEvolutionRequest))]
[JsonSerializable(typeof(AgentEvolutionResult))]
internal partial class ApiJsonContext : JsonSerializerContext
{
}
