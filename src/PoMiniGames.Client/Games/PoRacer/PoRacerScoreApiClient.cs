using System.Net.Http.Json;
using PoMiniGamesClient.Services;
using PoShared.Games;

namespace PoMiniGamesClient.Games.PoRacer;

public sealed class PoRacerScoreApiClient
{
    private readonly HttpClient _http;

    public PoRacerScoreApiClient(HttpClient http) => _http = http;

    public async Task<IReadOnlyList<PoRacerScoreDto>> GetTopAsync(int count = 10, CancellationToken ct = default)
    {
        var result = await _http.GetFromJsonAsync($"/api/poracer/scores?top={count}", ApiJsonContext.Default.ListPoRacerScoreDto, ct);
        return result ?? new List<PoRacerScoreDto>();
    }

    public async Task SubmitAsync(PoRacerScoreDto score, CancellationToken ct = default)
    {
        var response = await _http.PostAsJsonAsync("/api/poracer/scores", score, ApiJsonContext.Default.PoRacerScoreDto, ct);
        response.EnsureSuccessStatusCode();
    }
}
