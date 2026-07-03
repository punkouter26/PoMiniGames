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
[JsonSerializable(typeof(PoBrawlHighScore))]
[JsonSerializable(typeof(PoBrawlHighScore[]))]
[JsonSerializable(typeof(LeaderboardEntryDto))]
[JsonSerializable(typeof(GameLeaderboardDto))]
[JsonSerializable(typeof(GameLeaderboardDto[]))]
[JsonSerializable(typeof(MatchRecordRequest))]
[JsonSerializable(typeof(MatchRecordDto))]
[JsonSerializable(typeof(MatchRecordDto[]))]
[JsonSerializable(typeof(AuthHandshake))]
// PoSurvive — RemoteRelayInferenceService
[JsonSerializable(typeof(InferRequestDto))]
[JsonSerializable(typeof(InferenceResult))]
[JsonSerializable(typeof(PersonalityDnaDto))]
// PoSurvive — EvolutionClientService
[JsonSerializable(typeof(CrossoverRequestDto))]
[JsonSerializable(typeof(RecordEvolutionRequest))]
[JsonSerializable(typeof(AgentEvolutionResult))]
[JsonSerializable(typeof(EvolutionRequestDto))]
[JsonSerializable(typeof(EvolutionStateDto))]
[JsonSerializable(typeof(List<EvolutionStateDto>))]
[JsonSerializable(typeof(EvolutionSummaryDto))]
[JsonSerializable(typeof(EvolutionTreeDto))]
[JsonSerializable(typeof(EvolutionTreeNodeDto))]
// PoRacer
[JsonSerializable(typeof(PoRacerScoreDto))]
[JsonSerializable(typeof(List<PoRacerScoreDto>))]
// PoJoker
[JsonSerializable(typeof(PoShared.Games.PoJoker.JokeDto))]
[JsonSerializable(typeof(PoShared.Games.PoJoker.JokeFlags))]
[JsonSerializable(typeof(PoShared.Games.PoJoker.JokeAnalysisDto))]
[JsonSerializable(typeof(PoShared.Games.PoJoker.JokeRatingDto))]
[JsonSerializable(typeof(PoShared.Games.PoJoker.LeaderboardEntryDto), TypeInfoPropertyName = "JokerLeaderboardEntryDto")]
[JsonSerializable(typeof(List<PoShared.Games.PoJoker.LeaderboardEntryDto>), TypeInfoPropertyName = "ListJokerLeaderboardEntryDto")]
// PoFunQuiz
[JsonSerializable(typeof(QuizQuestion))]
[JsonSerializable(typeof(List<QuizQuestion>))]
// PoFace
[JsonSerializable(typeof(FaceStatusDto))]
[JsonSerializable(typeof(FaceSessionDto))]
[JsonSerializable(typeof(FaceRoundDto))]
[JsonSerializable(typeof(FaceScoreResponse))]
[JsonSerializable(typeof(List<FaceLeaderboardEntryDto>))]
[JsonSerializable(typeof(FaceLeaderboardEntryDto))]
// PoCoupleQuiz
[JsonSerializable(typeof(CoupleQuizTeamRow))]
[JsonSerializable(typeof(List<CoupleQuizTeamRow>))]
// PoClick — local session history (localStorage)
[JsonSerializable(typeof(PoClickSession))]
[JsonSerializable(typeof(List<PoClickSession>))]
// PoSurvive — SimulationOrchestrator grid serialisation
[JsonSerializable(typeof(PoSurvive.Shared.Models.GridStateDto))]
[JsonSerializable(typeof(PoSurvive.Shared.Models.AgentDto))]
[JsonSerializable(typeof(PoSurvive.Shared.Models.FoodNodeDto))]
[JsonSerializable(typeof(PoSurvive.Shared.Models.GridCoordinateDto))]
// SimulationLaunchService — E2EOverrides (internal type exposed via partial class trick not applicable; use separate context)
internal sealed partial class ApiJsonContext : JsonSerializerContext
{
}

/// <summary>§6 wire shape for the single-RTT <c>/api/auth/handshake</c> endpoint.</summary>
public sealed record AuthHandshake(AuthClientConfiguration Config, AuthenticatedUserProfile? User);
