using System.Net.Http.Json;
using PoShared.Games;

namespace PoMiniGamesClient.Games.PoRacer;

public sealed class PoRacerScoreApiClient
{
    private readonly HttpClient _http;

    public PoRacerScoreApiClient(HttpClient http) => _http = http;

    public async Task<IReadOnlyList<PoRacerScoreDto>> GetTopAsync(int count = 10, CancellationToken ct = default)
    {
        var result = await _http.GetFromJsonAsync<List<PoRacerScoreDto>>($"/api/poracer/scores?top={count}", ct);
        return result ?? new List<PoRacerScoreDto>();
    }

    public async Task SubmitAsync(PoRacerScoreDto score, CancellationToken ct = default)
    {
        var response = await _http.PostAsJsonAsync("/api/poracer/scores", score, ct);
        response.EnsureSuccessStatusCode();
    }
}
