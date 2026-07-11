namespace PoMiniGames.Features.PoFace;

public record FaceAnalysisResult(
    bool FaceDetected,
    float TargetEmotionConfidence,
    float Yaw,
    float Pitch,
    float Roll);

/// <summary>
/// Analyzes a webcam JPEG for the requested target emotion. Returns a confidence
/// score (0..1) plus estimated head pose. The scoring formula is
/// <c>score = headPoseValid ? round(confidence * 10) : 0</c>.
/// </summary>
public interface IFaceAnalysisService
{
    Task<FaceAnalysisResult> AnalyzeAsync(
        byte[] imageJpeg,
        TargetEmotion target,
        CancellationToken cancellationToken = default);

    bool IsMock { get; }
}
