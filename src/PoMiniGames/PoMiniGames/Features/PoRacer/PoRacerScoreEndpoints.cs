using Microsoft.AspNetCore.Mvc;
using PoShared.Games;

namespace PoMiniGames.Features.PoRacer;

public static class PoRacerScoreEndpoints
{
    private static readonly List<PoRacerScoreEntry> _scores = new();
    private static readonly object _lock = new();

    public static void MapPoRacerScoreEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/poracer/scores", (int? top) =>
        {
            top ??= 10;
            List<PoRacerScoreDto> result;
            lock (_lock)
            {
                result = _scores
                    .OrderBy(s => s.TotalTimeSeconds)
                    .Take(top.Value)
                    .Select(s => new PoRacerScoreDto
                    {
                        PlayerDisplayName = s.PlayerDisplayName,
                        TotalTimeSeconds = s.TotalTimeSeconds,
                        FinalPosition = s.FinalPosition,
                        AchievedAtUtc = s.AchievedAtUtc,
                        IsGuest = s.IsGuest,
                    })
                    .ToList();
            }
            return Results.Ok(result);
        });

        app.MapPost("/api/poracer/scores", ([FromBody] PoRacerScoreDto dto) =>
        {
            var errors = new Dictionary<string, string[]>();
            var name = dto.PlayerDisplayName?.Trim() ?? "";
            if (name.Length is 0 or > 32)
            {
                errors[nameof(dto.PlayerDisplayName)] = ["Player name is required (1-32 characters)."];
            }
            if (dto.TotalTimeSeconds is <= 0 or > 3600)
            {
                errors[nameof(dto.TotalTimeSeconds)] = ["Race time must be between 0 and 3600 seconds."];
            }
            if (dto.FinalPosition is < 1 or > 8)
            {
                errors[nameof(dto.FinalPosition)] = ["Final position must be between 1 and 8."];
            }
            if (errors.Count > 0)
            {
                return Results.ValidationProblem(errors);
            }

            var entry = new PoRacerScoreEntry
            {
                PlayerDisplayName = name,
                TotalTimeSeconds = dto.TotalTimeSeconds,
                FinalPosition = dto.FinalPosition,
                AchievedAtUtc = DateTimeOffset.UtcNow,
                IsGuest = dto.IsGuest,
            };
            lock (_lock)
            {
                _scores.Add(entry);
            }
            return Results.Created($"/api/poracer/scores", dto);
        });
    }
}

internal sealed class PoRacerScoreEntry
{
    public string PlayerDisplayName { get; set; } = "";
    public double TotalTimeSeconds { get; set; }
    public int FinalPosition { get; set; }
    public DateTimeOffset AchievedAtUtc { get; set; }
    public bool IsGuest { get; set; }
}
