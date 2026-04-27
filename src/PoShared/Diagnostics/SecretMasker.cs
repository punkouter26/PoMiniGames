namespace PoMiniGames.Shared.Diagnostics;

public static class SecretMasker
{
    public static string MaskMiddle(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "(null)";
        }

        if (value.Length <= 8)
        {
            return "******";
        }

        return value[..4] + "..." + value[^4..];
    }
}
