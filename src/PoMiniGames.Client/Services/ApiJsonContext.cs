using System.Text.Json.Serialization;
using PoMiniGamesClient.Models;
using PoShared.Games;
using PoSurvive.Client.Services;
using PoSurvive.Shared.Models;

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
// Stats + leaderboards
[JsonSerializable(typeof(PlayerStatsDto))]
[JsonSerializable(typeof(PlayerStatsDto[]))]
[JsonSerializable(typeof(PlayerStats))]
[JsonSerializable(typeof(MarbleRaceHighScore))]
[JsonSerializable(typeof(MarbleRaceHighScore[]))]
[JsonSerializable(typeof(PoBrawlHighScore))]
[JsonSerializable(typeof(PoBrawlHighScore[]))]
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
// PoFace
[JsonSerializable(typeof(FaceStatusDto))]
[JsonSerializable(typeof(FaceSessionDto))]
[JsonSerializable(typeof(FaceScoreResponse))]
[JsonSerializable(typeof(FaceLeaderboardEntryDto))]
[JsonSerializable(typeof(List<FaceLeaderboardEntryDto>))]
// PoCoupleQuiz
[JsonSerializable(typeof(CoupleQuizTeamRow))]
[JsonSerializable(typeof(List<CoupleQuizTeamRow>))]
// PoJoker
[JsonSerializable(typeof(PoShared.Games.PoJoker.JokeDto))]
[JsonSerializable(typeof(PoShared.Games.PoJoker.JokeFlags))]
[JsonSerializable(typeof(PoShared.Games.PoJoker.JokeAnalysisDto))]
// Disambiguate from client-side LeaderboardEntryDto: name the source-gen
// metadata property JokerLeaderboardEntryDto so the PoJoker leaderboard page
// resolves it.
[JsonSerializable(typeof(PoShared.Games.PoJoker.LeaderboardEntryDto), TypeInfoPropertyName = "JokerLeaderboardEntryDto")]
[JsonSerializable(typeof(List<PoShared.Games.PoJoker.LeaderboardEntryDto>), TypeInfoPropertyName = "ListJokerLeaderboardEntryDto")]
// PoClick (local-only)
[JsonSerializable(typeof(PoClickSession))]
[JsonSerializable(typeof(List<PoClickSession>))]
// PoRacer
[JsonSerializable(typeof(PoRacerScoreDto))]
[JsonSerializable(typeof(List<PoRacerScoreDto>))]
// PoSurvive — inference
[JsonSerializable(typeof(InferRequestDto))]
[JsonSerializable(typeof(InferenceResult))]
[JsonSerializable(typeof(PersonalityDnaDto))]
[JsonSerializable(typeof(GridStateDto))]
// PoSurvive — evolution
[JsonSerializable(typeof(CrossoverRequestDto))]
[JsonSerializable(typeof(RecordEvolutionRequest))]
[JsonSerializable(typeof(AgentEvolutionResult))]
[JsonSerializable(typeof(EvolutionRequestDto))]
[JsonSerializable(typeof(EvolutionStateDto))]
[JsonSerializable(typeof(List<EvolutionStateDto>))]
[JsonSerializable(typeof(EvolutionSummaryDto))]
[JsonSerializable(typeof(EvolutionTreeDto))]
[JsonSerializable(typeof(EvolutionTreeNodeDto))]
internal partial class ApiJsonContext : JsonSerializerContext
{
}
