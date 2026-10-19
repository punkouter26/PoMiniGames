using System.Text.Json;

namespace PoMiniGamesClient.Games.PoCabinet;

/// <summary>The last race this browser finished, for the start card's "Last race" tile.</summary>
public sealed record PoCabinetLastRace(string TrackId, int Position, int TotalCars, double BestLapSeconds, bool Online, DateTimeOffset AtUtc);

/// <summary>
/// The start card's read of what this browser already knows: the personal best per track
/// (settings.js owns <c>pocabinet.records.v1</c>; this only reads it) and the last race.
/// Plain localStorage strings, parsed here, so the card needs no engine import.
/// </summary>
public static class PoCabinetPitWall
{
    public const string RecordsKey = "pocabinet.records.v1";
    public const string LastRaceKey = "pocabinet.lastrace.v1";
    public const string PaintKey = "pocabinet.paintshop.v1";

    /// <summary>Best lap per track id from settings.js's records store; unset or corrupt tracks are left out.</summary>
    public static Dictionary<string, double> ParseBestLaps(string? json)
    {
        var bests = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(json)) return bests;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return bests;
            foreach (var track in doc.RootElement.EnumerateObject())
            {
                if (track.Value.ValueKind == JsonValueKind.Object
                    && track.Value.TryGetProperty("bestLap", out var lap)
                    && lap.ValueKind == JsonValueKind.Number
                    && lap.GetDouble() is var seconds and > 0)
                {
                    bests[track.Name] = seconds;
                }
            }
        }
        catch (JsonException) { /* hand-edited or stale: no bests */ }
        return bests;
    }

    public static PoCabinetLastRace? ParseLastRace(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonSerializer.Deserialize(json, PoCabinetJsonContext.Default.PoCabinetLastRace); }
        catch (JsonException) { return null; }
    }

    public static string Serialize(PoCabinetLastRace race) =>
        JsonSerializer.Serialize(race, PoCabinetJsonContext.Default.PoCabinetLastRace);

    /// <summary>The paint shop's stored "&lt;livery&gt;|&lt;color&gt;", or null when unset or malformed.</summary>
    public static (string Livery, string Color)? ParsePaint(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var parts = raw.Split('|', 2);
        return parts.Length == 2 && parts[0].Length > 0 && parts[1].Length > 0 ? (parts[0], parts[1]) : null;
    }
}
