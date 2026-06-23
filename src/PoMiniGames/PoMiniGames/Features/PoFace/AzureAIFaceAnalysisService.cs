using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace PoMiniGames.Features.PoFace;

/// <summary>
/// Server-side Azure OpenAI multimodal face analyzer. Calls the shared
/// <c>po-aiservices-shared</c> account's multimodal deployment (e.g.
/// <c>gpt-5-nano</c>) and asks the model to score the target emotion in
/// a frame. Model returns JSON; we deserialize and clamp.
///
/// <para>The head-pose estimate is model-generated (not measured geometry)
/// — same caveat as the source PoFace code. The <see cref="HeadPoseValidator"/>
/// gate keeps scoring parity.</para>
///
/// <para>Mock fallback: gated on <c>IsDevelopment() || IsEnvironment("Test")</c>
/// AND the explicit <c>UseRealFaceApi=false</c> flag. In Production, missing
/// config throws <see cref="InvalidOperationException"/> on first call rather
/// than silently serving fabricated data — per the 2026-06-13 mock-data fix.</para>
/// </summary>
public sealed class AzureAIFaceAnalysisService : IFaceAnalysisService
{
    /// <summary>
    /// The HttpClient name registered in <see cref="PoMiniGames.Infrastructure.GameServicesExtensions"/>.
    /// Use this constant (not <c>nameof(this)</c>) when calling
    /// <c>IHttpClientFactory.CreateClient</c> so a rename of the class doesn't break wiring.
    /// </summary>
    public const string HttpClientName = "PoFace.AzOpenAI";

    public bool IsMock => false;

    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<AzureAIFaceAnalysisService> _logger;
    private readonly HttpClient _http;
    private readonly string? _configErrorMessage;

    public AzureAIFaceAnalysisService(
        IConfiguration configuration,
        IHostEnvironment environment,
        ILogger<AzureAIFaceAnalysisService> logger,
        IHttpClientFactory httpClientFactory)
    {
        _configuration = configuration;
        _environment = environment;
        _logger = logger;
        _http = httpClientFactory.CreateClient(HttpClientName);

        var endpoint = configuration["PoFace:AzureOpenAI:Endpoint"];
        var apiKey = configuration["PoFace:AzureOpenAI:ApiKey"];
        var deployment = configuration["PoFace:AzureOpenAI:DeploymentName"];
        var apiVersion = configuration["PoFace:AzureOpenAI:ApiVersion"] ?? "2025-01-01-preview";

        if (string.IsNullOrWhiteSpace(endpoint) || string.IsNullOrWhiteSpace(apiKey) || string.IsNullOrWhiteSpace(deployment))
        {
            _configErrorMessage = "PoFace:AzureOpenAI:Endpoint/ApiKey/DeploymentName are not configured.";
            return;
        }

        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        }
        _http.BaseAddress = new Uri(endpoint.TrimEnd('/') + $"/openai/deployments/{deployment}/");
        // The api-version is a query string on the request URL; stash it.
        _http.DefaultRequestHeaders.Add("Api-Version-Querystring", apiVersion);
    }

    public async Task<FaceAnalysisResult> AnalyzeAsync(byte[] imageJpeg, TargetEmotion target, CancellationToken cancellationToken = default)
    {
        if (imageJpeg is null || imageJpeg.Length == 0)
        {
            return new FaceAnalysisResult(false, 0, 0, 0, 0);
        }

        var useReal = _configuration.GetValue<bool>("PoFace:Features:UseRealFaceApi");
        if (!useReal && IsNonProduction())
        {
            _logger.LogWarning("PoFace: UseRealFaceApi=false in {Environment}; serving stub analysis.", _environment.EnvironmentName);
            return StubFaceAnalysisService.Analyze(target);
        }

        if (_configErrorMessage is not null)
        {
            if (IsNonProduction())
            {
                _logger.LogWarning("PoFace: Azure OpenAI not configured; serving stub analysis in {Environment}.", _environment.EnvironmentName);
                return StubFaceAnalysisService.Analyze(target);
            }
            throw new InvalidOperationException(_configErrorMessage);
        }

        try
        {
            var base64 = Convert.ToBase64String(imageJpeg);
            var systemPrompt = "You analyze a single face photo for a facial emotion game. " +
                               "Respond with a JSON object: " +
                               "{\"faceDetected\":<bool>,\"targetEmotionConfidence\":<0.0-1.0>,\"yaw\":<float>,\"pitch\":<float>,\"roll\":<float>}. " +
                               "No explanations. Confidence is the likelihood that the face is showing the requested emotion.";
            var userPrompt = $"Target emotion: {target}. Score this image.";
            var body = new
            {
                messages = new object[]
                {
                    new { role = "system", content = systemPrompt },
                    new {
                        role = "user",
                        content = new object[]
                        {
                            new { type = "text", text = userPrompt },
                            new { type = "image_url", image_url = new { url = $"data:image/jpeg;base64,{base64}" } }
                        }
                    }
                },
                response_format = new { type = "json_object" },
                max_completion_tokens = 4000
            };
            var json = JsonSerializer.Serialize(body);
            var version = _http.DefaultRequestHeaders.GetValues("Api-Version-Querystring").First();
            var request = new HttpRequestMessage(HttpMethod.Post, $"chat/completions?api-version={version}")
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            };
            var response = await _http.SendAsync(request, cancellationToken);
            response.EnsureSuccessStatusCode();
            var responseJson = await response.Content.ReadAsStringAsync(cancellationToken);
            using var doc = JsonDocument.Parse(responseJson);
            var content = doc.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString() ?? "{}";
            using var inner = JsonDocument.Parse(content);
            var faceDetected = inner.RootElement.TryGetProperty("faceDetected", out var fd) && fd.GetBoolean();
            var confidence = inner.RootElement.TryGetProperty("targetEmotionConfidence", out var c) ? Math.Clamp((float)c.GetDouble(), 0f, 1f) : 0f;
            var yaw = inner.RootElement.TryGetProperty("yaw", out var y) ? (float)y.GetDouble() : 0f;
            var pitch = inner.RootElement.TryGetProperty("pitch", out var p) ? (float)p.GetDouble() : 0f;
            var roll = inner.RootElement.TryGetProperty("roll", out var r) ? (float)r.GetDouble() : 0f;
            return new FaceAnalysisResult(faceDetected, confidence, yaw, pitch, roll);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PoFace: Azure OpenAI face analysis failed.");
            if (IsNonProduction())
            {
                return StubFaceAnalysisService.Analyze(target);
            }
            throw;
        }
    }

    private bool IsNonProduction() => _environment.IsDevelopment() || _environment.IsEnvironment("Test");
}

/// <summary>
/// Deterministic stub used in Dev/Test and as a fallback when Azure OpenAI
/// is unreachable. Always reports no face detected — score is always 0.
/// Marked with the IMockable-equivalent <see cref="IFaceAnalysisService.IsMock"/>
/// so the runtime-status endpoint can drive the "USING MOCK DATA" banner.
/// </summary>
public sealed class StubFaceAnalysisService : IFaceAnalysisService
{
    public bool IsMock => true;

    public Task<FaceAnalysisResult> AnalyzeAsync(byte[] imageJpeg, TargetEmotion target, CancellationToken cancellationToken = default)
    {
        // Deterministic: no face detected in stub mode. Score = 0.
        return Task.FromResult(new FaceAnalysisResult(false, 0f, 0f, 0f, 0f));
    }

    public static FaceAnalysisResult Analyze(TargetEmotion target) =>
        new(false, 0f, 0f, 0f, 0f);
}
