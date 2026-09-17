using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Games.PoRacer;

internal static class PoRacerPreferences
{
    private const string Key = "PoRacer.Customization";
    public static PoRacerCarCustomization LoadCustomization()
    {
        var parts = LocalStorageService.GetItem<string>(Key)?.Split('|');
        return parts is { Length: 2 } && parts[0].Length == 7 && parts[0][0] == '#' &&
            parts[0].Skip(1).All(Uri.IsHexDigit) && parts[1] is "stripe" or "dual" or "carbon" or "neon"
            ? new(parts[0], parts[1]) : PoRacerCarCustomization.Default;
    }
    public static void SaveCustomization(PoRacerCarCustomization customization) =>
        LocalStorageService.SetItem(Key, $"{customization.ColorHex}|{customization.LiveryPattern}");
}
