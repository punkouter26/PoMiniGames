using System.Text.Json;

namespace PoMiniGamesClient.Games.PoCabinet;

/// <summary>
/// What the page reads from this browser before the engine is imported: the personal best per
/// track for the track list (records.js owns <c>pocabinet.records.v1</c>; this only reads it)
/// and the stored paint job. Plain localStorage strings, parsed here.
/// </summary>
public static class PoCabinetPitWall
{
    public const string RecordsKey = "pocabinet.records.v1";
    public const string PaintKey = "pocabinet.paintshop.v1";

    /// <summary>Best lap per track id from records.js's store; unset or corrupt tracks are left out.</summary>
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

    /// <summary>The paint shop's stored "&lt;livery&gt;|&lt;color&gt;", or null when unset or malformed.</summary>
    public static (string Livery, string Color)? ParsePaint(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var parts = raw.Split('|', 2);
        return parts.Length == 2 && parts[0].Length > 0 && parts[1].Length > 0 ? (parts[0], parts[1]) : null;
    }
}
