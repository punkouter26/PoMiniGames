using System.Net.Http.Json;
using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;
using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Games.PoRacer;

public sealed class PoRacerScoreApiClient
{
    private readonly HttpClient _http;

    public PoRacerScoreApiClient(HttpClient http) => _http = http;

    public async Task<IReadOnlyList<PoRacerScoreDto>> GetTopAsync(int count = 10, string? trackId = null, CancellationToken ct = default)
    {
        var uri = string.IsNullOrWhiteSpace(trackId)
            ? $"/api/poracer/scores?top={count}"
            : $"/api/poracer/scores?top={count}&track={Uri.EscapeDataString(trackId)}";
        var result = await _http.GetFromJsonAsync(uri, ApiJsonContext.Default.ListPoRacerScoreDto, ct);
        return result ?? new List<PoRacerScoreDto>();
    }

    public async Task SubmitAsync(PoRacerScoreDto score, CancellationToken ct = default)
    {
        var response = await _http.PostAsJsonAsync("/api/poracer/scores", score, ApiJsonContext.Default.PoRacerScoreDto, ct);
        response.EnsureSuccessStatusCode();
    }
}
