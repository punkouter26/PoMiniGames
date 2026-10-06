using System.Text.Json;
using System.Text.Json.Serialization;

namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>
/// A match in progress as a string, for the browser to keep between months. Source-generated
/// so it survives trimming.
/// </summary>
public static class PoMuleSave
{
    public static string ToJson(MatchState state) => JsonSerializer.Serialize(state, PoMuleJsonContext.Default.MatchState);

    /// <summary>The saved match, or null when the text is damaged or from an older rules version.</summary>
    public static MatchState? FromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            var state = JsonSerializer.Deserialize(json, PoMuleJsonContext.Default.MatchState);
            return state is { Version: MatchState.CurrentVersion, Players.Length: PoMuleTuning.Seats }
                && state.Owner.Length == PoMuleMap.Columns * PoMuleMap.Rows
                ? state
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

[JsonSerializable(typeof(MatchState))]
public sealed partial class PoMuleJsonContext : JsonSerializerContext;
