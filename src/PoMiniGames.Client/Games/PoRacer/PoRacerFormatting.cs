namespace PoMiniGamesClient.Games.PoRacer;

internal static class PoRacerFormatting
{
    public static string Time(double seconds) =>
        !double.IsFinite(seconds) || seconds <= 0 || seconds > 3600
            ? "—" : $"{(int)(seconds / 60)}:{seconds % 60:00.000}";
}
